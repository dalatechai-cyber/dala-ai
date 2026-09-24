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
 *   stale? → match → canned lines reviewed? → short-circuit? → any tenant data? →
 *   mark called → call → settle → guard → draft
 *
 * Four of those come **before** the model call and each can end the request for free:
 * a stale event, an unparseable matcher, an unreviewed canned line, and a tenant with no
 * knowledge base at all. The cheapest refusals are first, and none of them costs a token.
 */
import type { CallOutcome, ReceptionRequest, TerminalReason } from '../model/reception.ts';
import { isStale } from '../model/reception.ts';
import type { Usage } from '../spend/settle.ts';
import { kindsRequiredByRules, kindsReferencedBy, matchRules, renderCannedSection, type CannedRow, type GateRule } from '../gate/match.ts';
import { cannedHashOf } from '../prompt/sections.ts';
import {
  composeQuoted, matchDeterministic, withAppended, type DeterministicRule, type HistoryState,
} from '../gate/deterministic.ts';
import { isTenantConfirmed } from '../provenance.ts';
import { appendedNotice } from './volatile.ts';
import { tenantRegion, ungroundedSentences } from '../guard/grounding.ts';
import { refusalMarkerFrom, unwarrantedApology } from '../guard/apology.ts';
import { fold } from '../mn/text.ts';
import { SECTION_LABELS } from '../prompt/tenant.ts';
import { checkPinnedLines, faqAdaptation } from '../gate/pinned.ts';
import { outboundGuard, type TenantGuardView } from '../guard/outbound.ts';
import { hasTenantData } from '../prompt/tenant.ts';
import { priceLineReport } from '../quality/priceLines.ts';
import { serviceNameReport, type PricedService } from '../quality/serviceNames.ts';
import { pricePresentation, renderQuotedRows } from '../guard/pricePresentation.ts';

/**
 * One `quality_flags` row per model reply whose text broke the price-presentation rule,
 * whatever was then served. The count decision 3 is waiting on (D-115).
 */
export const PRICE_VIOLATION_FLAG = 'price_violation_seen';
import { bookingApology, renderBookingAnswer, apologyStemsFrom } from '../guard/bookingApology.ts';
import { capToSingleMessage } from '../mn/text.ts';

/** One Messenger send, in characters. */
export const MAX_REPLY_CHARS = 1900;

/**
 * What produced this reply, as `messages.answered_by` records it.
 *
 * `0001`'s CHECK has allowed all four values since the schema was written; three are
 * reachable from here and `human` belongs to a surface that does not exist yet.
 *
 *  - `deterministic` — a `deterministic_replies` row matched before any model call. Costs
 *    nothing and is the largest single saving in the design (§6.3.8).
 *  - `canned`        — a `canned_responses` line: a gate short-circuit, or the handoff.
 *  - `model`         — the model wrote it, and the outbound guard let it through.
 *
 * They are kept apart because the first question anyone asks of the mirror's corpus is how
 * often a row answered without the model, and a single `canned` for both cannot answer it.
 */
export type AnsweredBy = 'model' | 'canned' | 'deterministic';

export type ReceptionDeps = {
  callModel: (req: ReceptionRequest) => Promise<CallOutcome>;
  /** Store the reply exactly once per dedup key. Returns the row id. */
  draft: (input: { body: string; answeredBy: AnsweredBy }) => Promise<{ ok: true; id: string } | { ok: false; detail: string }>;
  /** Mark the reservation called, immediately before the provider call. */
  markCalled: () => Promise<boolean>;
  /** Record what was actually spent, with the real usage block. */
  settle: (usage: Usage, modelId: string) => Promise<{ ok: true } | { ok: false; detail: string }>;
  /** Give an unused hold straight back. */
  release: () => Promise<void>;
  /** Record a guard refusal or a terminal model outcome for the Quality layer. */
  flag: (input: { code: string; detail: string; attempted?: string }) => Promise<void>;
  /**
   * Health signals from the call itself (§6.10.5). Separate from `flag` because these are
   * not about THIS reply — a cold cache and a swapped model are both correct answers that
   * cost the wrong amount, and neither changes what the customer is told.
   */
  observe: (input: {
    requestedModel: string;
    /** `response.model`, or '' when the API did not report one. */
    servedModel: string;
    usage?: Usage;
    terminalReason?: TerminalReason;
  }) => Promise<void>;
};

export type ReceptionInput = {
  customerMessage: string;
  /**
   * Attachment kinds on this message, for the gate (D-083).
   *
   * Required, not optional-with-a-default. A default of `[]` would mean "this message had
   * no attachment", which is the wrong answer for a caller that simply forgot — and the
   * case it would get wrong is the captioned photograph, the one the field exists for.
   * A new caller that does not know should not compile.
   */
  customerAttachments: readonly string[];
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
  /** §6.8's pre-model layer. Empty is normal: every rule is opt-in per tenant. */
  deterministic: readonly DeterministicRule[];
  /**
   * What we know about the conversation so far. `known: false` is NOT `empty: true` —
   * collapsing them makes a storage hiccup greet an existing customer from scratch.
   */
  historyState: HistoryState;
  canned: readonly CannedRow[];
  tenantGuard: TenantGuardView;
  /** Label for the pinned-line section the gate's blocks point into. */
  cannedLabel: string;
  /**
   * The canned-line identity recorded on the published snapshot (D-058).
   *
   * A string means the prefix ALREADY CARRIES the canned section, so it must not be
   * appended again — and the live rows must still render to this hash, or the model would
   * be quoting one version while the deterministic short-circuit answers from another.
   * `null` means the snapshot predates the move and the section still belongs in the
   * volatile tail. Not a skipped check: a format marker with two correct branches.
   */
  cannedHash: string | null;
  /**
   * The service names the tenant's price list renders, for the name-fidelity COUNTER.
   *
   * Derived from `promptStable` by `servicesFromPrefix`, so it costs no query. Required
   * rather than defaulted: `[]` would silently mean "this tenant sells nothing", and a
   * caller that forgets would turn the counter off rather than fail — which is the shape
   * `customerAttachments` already refuses for the same reason.
   */
  serviceNames: readonly PricedService[];
  /**
   * The tenant's «УРЬДЧИЛГАА ТӨЛБӨР» rows, verbatim from the prefix, for the booking answer
   * the platform serves when the model opens one with an apology. Derived by `sectionRows`,
   * so it costs no query. Empty is a real state: a tenant with no deposits gets the link
   * alone, which is still the answer the founder asked for minus a fact it does not have.
   */
  depositRows: readonly string[];
  /**
   * The tenant's FAQ ANSWERS, verbatim from the prefix.
   *
   * Founder, 2026-09-21: *"Pin FAQ answers exactly like canned rows. Reviewed text is
   * served as written."* They carry no `reviewed_at` of their own — `renderTenantSections`
   * says why: the review unit for tenant data is the REVISION, and an answer only reaches
   * the compiled prefix by being published. So being here IS the approval.
   */
  faqAnswers: readonly string[];
};

export type ReceptionOutcome =
  /** A reply row exists and is ready for the send path. */
  | { kind: 'drafted'; outboundId: string; answeredBy: AnsweredBy; refusal?: string }
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
 * The tenant's "set" rows: a confirmed, enabled `replace` row that quotes two or more
 * price-list services (`0041`). Its `quote_services` order and its body are the tenant's
 * own presentation of that set — Matrix's colour rows, root first, then the founder's
 * question — so wherever the platform serves those prices FROM DATA, it serves them this
 * way. Founder, 2026-09-24: *"…then my question, also when served from data."*
 */
/** A set is two or more services; one service quoted is a price, not a choice to ask about. */
const MIN_SET_SERVICES = 2;

function setRows(rules: readonly DeterministicRule[]): DeterministicRule[] {
  return rules.filter((r) => r.enabled && r.placement === 'replace' && r.quoteServices.length >= MIN_SET_SERVICES
    && isTenantConfirmed(r.provenance));
}

/** The set row covering every quoted service, when at least two of its services are quoted. */
function setRowFor(rules: readonly DeterministicRule[], quoted: readonly { name: string }[]): DeterministicRule | null {
  if (quoted.length < MIN_SET_SERVICES) return null;
  return setRows(rules).find((r) => quoted.every((q) => r.quoteServices.includes(q.name))) ?? null;
}

/**
 * Does the reply already list the set's services in the row's order and then ask its
 * question? A reply that does is left exactly as written.
 */
function inSetOrder(text: string, row: DeterministicRule): boolean {
  const f = fold(text);
  let at = -1;
  for (const name of row.quoteServices) {
    const i = f.indexOf(fold(name));
    if (i <= at) return false;
    at = i;
  }
  const q = row.body.trim();
  return q === '' || f.indexOf(fold(q), at) > at;
}

/**
 * The prices this reply quoted, served from the price list rather than as the model wrote
 * them: the set row when one covers them, else the rows themselves. Null when the owner of
 * a price is unknowable or nothing was quoted — the platform then does not guess.
 */
function dataAnswer(text: string, input: ReceptionInput): string | null {
  const p = pricePresentation(text, input.serviceNames);
  if (p.ambiguous || p.quoted.length === 0) return null;
  const row = setRowFor(input.deterministic, p.quoted);
  if (row !== null) {
    const composed = composeQuoted(row, input.serviceNames);
    if (composed !== null) return composed;
  }
  const rows = renderQuotedRows(p.quoted);
  return rows === '' ? null : rows;
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
  /**
   * Response kinds to try BEFORE the generic line, most specific first — normally
   * `matched.matchedResponseKinds`.
   *
   * Founder's rule, 2026-09-21: *"When a question is refused, serve the reviewed reply
   * for it, never the generic handoff. Customers must see the refusal line written for
   * that question."*
   *
   * Measured the same day, turn 14: «dund zergiin usend shuluun himi hedeer hiih ve»
   * fired `suitability_lat_himi`, the guard refused the model's (correct) price, and the
   * customer got «Уучлаарай, би энэ асуултад хариулж чадахгүй байна…» — while the
   * tenant's own reviewed `refusal_suitability` row, written for exactly that question,
   * went unused. The generic line is what you say when you do not know what was asked;
   * here we knew.
   *
   * Defaulted to `[]` rather than required, and this is the one place a default is
   * right: every existing caller then keeps today's behaviour exactly, and the fallback
   * is the generic line either way, so a caller that forgets loses a better sentence
   * rather than gaining a wrong one. `canned()` already returns null for a missing OR
   * unreviewed row, so an unreviewed specific line cannot be served by this path — it
   * falls through to the generic one, which is the safe direction.
   */
  prefer: readonly string[] = [],
): Promise<ReceptionOutcome> {
  let servedKind = 'handoff';
  let line: string | null = null;
  for (const kind of prefer) {
    const specific = canned(input.canned, kind);
    if (specific !== null) { line = specific; servedKind = kind; break; }
  }
  if (line === null) line = canned(input.canned, 'handoff');
  if (line === null) {
    return { kind: 'retry', detail: `no reviewed handoff line: cannot answer ${reason.code}` };
  }
  // WHICH line was served goes in the flag. Two refusals that differ only in the sentence
  // the customer read are indistinguishable in the corpus otherwise, and "did the specific
  // line fire?" is the only question this change can be judged by.
  await deps.flag({ ...reason, detail: `${reason.detail} [served: ${servedKind}]` });
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
  const matched = matchRules({ text: input.customerMessage, attachments: input.customerAttachments }, input.rules);
  if (!matched.ok) {
    await deps.release();
    return { kind: 'retry', detail: `matcher unusable: ${matched.detail}` };
  }

  // 3. Every pinned line has a native-speaker sign-off. A gate pointing at an unreviewed
  //    sentence is a check with no answer.
  // D-020: a refusal that fired on a row nobody has confirmed still fired — the customer
  // is protected either way — but it is recorded, because "the bot refused" and "the bot
  // refused on a rule somebody guessed" are different facts about the same reply, and only
  // the flag can tell them apart afterwards. Written before the review gate below, so the
  // signal survives a request that ends there.
  if (matched.unconfirmedTopics.length > 0) {
    await deps.flag({
      code: 'gate_rule_unconfirmed',
      detail: `refusal rules fired without tenant confirmation: ${matched.unconfirmedTopics.join(', ')}`,
    });
  }

  // The kinds are read out of the prefix the model will actually be given, not from a
  // list kept in step by hand — the same reasoning as `ops.tenant_scope` being derived
  // from the catalog. A block added to L0 that names a new kind therefore starts
  // refusing for tenants that have not provisioned it, without anyone remembering to
  // update a constant.
  // Two sources, unioned: the kinds the PREFIX names, and the kinds the TENANT'S OWN
  // rules point at. The second is not redundant — a `response_kind` is never rendered into
  // the prefix, so a rule whose line is missing used to fire into nothing at all and the
  // model improvised on the one topic the business asked never to be discussed. See
  // `kindsRequiredByRules`.
  const required = [
    ...new Set([...kindsReferencedBy([input.promptStable]), ...kindsRequiredByRules(input.rules)]),
  ].sort();
  const section = renderCannedSection(input.cannedLabel, input.canned, required);
  if (!section.ok) {
    await deps.release();
    // `retry`, not `dropped`, for both codes: the fault is a row an operator can add, and
    // a 503 means QStash still holds the customer's message. Dropping it would lose a real
    // question permanently to fix a problem that outlives the request by minutes.
    return { kind: 'retry', detail: `${section.code}: ${section.kinds.join(', ')}` };
  }

  // THE ROWS AND THE PREFIX MUST BE THE SAME TEXT (D-058).
  //
  // Since the canned lines moved into the compiled prefix, the same sentence has two
  // sources: the published snapshot, which is what the model reads, and the live rows,
  // which is what the deterministic short-circuit answers from. Edit a row without
  // republishing and one customer gets the new line from the gate while the next gets the
  // old one from the model — D-039's shape, two sources of one fact, and nothing in the
  // data would say which was which.
  //
  // So a divergence is a 503. QStash holds the message, the operator republishes, the
  // reply goes out. That is strictly better than answering from either copy: choosing the
  // rows means the model is told to reproduce a sentence its prefix does not contain, and
  // choosing the prefix means an edit an operator has already made is silently ignored.
  if (input.cannedHash !== null && cannedHashOf(input.canned) !== input.cannedHash) {
    await deps.release();
    return { kind: 'retry', detail: 'canned_stale: the canned lines have changed since this configuration was published' };
  }

  // 4. §6.8's pre-model layer: a greeting or an address question answered from a row, in
  //    ~200ms instead of ~3s, for ₮0. §6.3.8 prices what this absorbs at ₮26,300 per
  //    tenant-month, which is the largest single saving in the design.
  //
  //    It runs AFTER the review gate on purpose: a deterministic reply is still a
  //    customer-visible sentence, and an unreviewed one must not ship just because no
  //    model was involved in choosing it.
  const shortcut = matchDeterministic(input.customerMessage, input.deterministic, input.historyState,
    { hasAttachment: input.customerAttachments.length > 0 });
  // `append` rows (`0041`): whatever is served from here on, their bodies go at the END.
  // Founder, 2026-09-24: *"The Tara line must never replace an answer. Only a question about
  // the name gets the line on its own."* Every draft below goes through `d`, handoff
  // included, so no path can serve an answer without the line or the line without an answer.
  const appends = shortcut.appends;
  const d: ReceptionDeps = appends.length === 0 ? deps : {
    ...deps,
    draft: (x) => deps.draft({ ...x, body: withAppended(x.body, appends) }),
  };
  // The other direction of the same rule: this row MATCHED and was withheld, because its
  // body would have been sent to the customer verbatim. The model answers instead, at the
  // cost of one call — and the flag is the only trace that a provisioned answer existed and
  // was not trusted.
  if (shortcut.suppressed.length > 0) {
    await deps.flag({
      code: 'deterministic_reply_unconfirmed',
      detail: `matched but withheld pending tenant confirmation: ${shortcut.suppressed.join(', ')}`,
    });
  }
  // A row that quotes prices renders them from the compiled price list. If one of its
  // services is not on the list, the row does not answer and the model does — with a flag,
  // because a set row that silently stopped firing is a dead row nobody can see.
  const shortcutBody = shortcut.hit === null ? null : composeQuoted(shortcut.hit, input.serviceNames);
  if (shortcut.hit !== null && shortcutBody === null) {
    await deps.flag({
      code: 'deterministic_reply_unresolved',
      detail: `${shortcut.hit.intent} names a service the price list does not carry: ${shortcut.hit.quoteServices.join(', ')}`,
    });
  }
  if (shortcut.hit !== null && shortcutBody !== null) {
    await deps.release();   // nothing was spent, so the hold goes straight back
    // `deterministic`, not `canned`. `0001`'s CHECK has carried both values since the
    // schema was written and nothing had ever used the distinction: a `deterministic_replies`
    // row and a `canned_responses` line are different tables, reviewed differently, and cost
    // a different amount to serve (this path spends nothing at all). Recording both as
    // `canned` would make the mirror's corpus unable to answer the first question anybody
    // asks of it — how often did a row answer without the model.
    const drafted = await d.draft({ body: shortcutBody, answeredBy: 'deterministic' });
    return drafted.ok
      ? { kind: 'drafted', outboundId: drafted.id, answeredBy: 'deterministic' }
      : { kind: 'retry', detail: drafted.detail };
  }

  // 5. The opt-in short-circuit: answer from a row, with no model call at all. Off by
  //    default per topic per tenant; only a measured precision run turns it on.
  if (matched.shortCircuitKind !== null) {
    const line = canned(input.canned, matched.shortCircuitKind);
    if (line === null) {
      await deps.release();
      return { kind: 'retry', detail: `short-circuit names ${matched.shortCircuitKind}, which is missing or unreviewed` };
    }
    await deps.release();   // nothing was spent, so the hold goes straight back
    const drafted = await d.draft({ body: line, answeredBy: 'canned' });
    return drafted.ok
      ? { kind: 'drafted', outboundId: drafted.id, answeredBy: 'canned' }
      : { kind: 'retry', detail: drafted.detail };
  }

  // 6. NO FACTS, NO CALL. A tenant whose compiled prefix carries none of its own data
  //    gets the handoff line, and the model is never asked.
  //
  //    This is not a saving that happens to be safe; it is a safety property that happens
  //    to be cheap. The gate blocks describe how a business with a knowledge base should
  //    behave, and `00_gate_preamble` rule (4) ends with "answer normally from the
  //    knowledge base below". For a tenant with no rows there is nothing below, no rule
  //    covers the case, and the only business-type vocabulary left in the context is the
  //    salon in Ш1, Ш3, Ш6 and Ш8's examples. The first real reply this platform sent
  //    greeted a customer on behalf of a beauty salon; the tenant sells software (D-033).
  //
  //    The outbound guard cannot catch it. Its allow-list is over NUMERALS — which worked:
  //    `allowed_numbers` was empty, so no price could be quoted. There is no allow-list of
  //    permissible claims about what the business IS, and in Mongolian there could not be
  //    a useful deny-list of them either; that is the input-filter fallacy the guard's own
  //    header rejects. So the fix is upstream of the model, not downstream of it.
  //
  //    It runs AFTER both short-circuits on purpose: a deterministic reply and a gate
  //    short-circuit both answer from a row the tenant wrote, so nothing can be invented
  //    and there is no reason to withhold them.
  //
  //    KNOWN AND ACCEPTED: business hours live in the volatile tail, not the stable
  //    prefix, so a tenant with hours entered and nothing else is refused here even though
  //    one fact exists. Conservative in the safe direction, and it describes a tenant that
  //    is minutes into provisioning rather than one in service.
  if (!hasTenantData(input.promptStable)) {
    await deps.release();   // nothing was spent, so the hold goes straight back
    // The specific line applies here too. D-033's concern is the model INVENTING a
    // business from an empty prefix; a reviewed canned row is the tenant's own words, so
    // serving one cannot invent anything. A day-one tenant that has written its
    // children's-services refusal should say that, not «I can't answer this».
    return handoff(d, input, {
      code: 'no_tenant_data',
      detail: 'the compiled prefix carries no tenant sections: the model would have nothing to answer from',
    }, matched.matchedResponseKinds);
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

  // The lines an `append` row will add, so the model does not contradict them — per
  // request, in L4, never in the cached prefix: they depend on this customer's message.
  const volatile = appends.length === 0
    ? input.promptVolatile
    : `${input.promptVolatile}\n${appendedNotice(appends.map((a) => a.body))}`;

  const result = await deps.callModel({
    modelId: input.modelId,
    promptStable: input.promptStable,
    // The canned section is in the CACHED prefix now (D-058) unless this snapshot predates
    // the move, in which case it is still appended here. ~1,000 tokens per reply that used
    // to be paid at full input rate for text that only changes at publish.
    promptVolatile: input.cannedHash === null
      ? `${volatile}\n${section.body}`.trim()
      : volatile,
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

  // Health first, so a bookkeeping failure below cannot swallow the signal.
  await deps.observe({
    requestedModel: input.modelId,
    servedModel: result.kind === 'ok' ? result.modelReturned : '',
    ...(result.usage === undefined ? {} : { usage: result.usage }),
    ...(result.kind === 'terminal' ? { terminalReason: result.reason } : {}),
  });

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
    return handoff(d, input,
      { code: `model_${result.reason}`, detail: result.detail },
      matched.matchedResponseKinds);
  }

  // ---- Was this a pinned line, reproduced or paraphrased? ----------------
  //
  // Four gate blocks tell the model to copy an approved sentence «нэг ч үсэг өөрчлөхгүйгээр»
  // — without changing a single letter — and until 2026-09-14 that was a request with no
  // check behind it. Matrix's third mirror draft dropped «би» from the handoff line. The
  // draft nine minutes earlier is byte-exact and is NOT a counter-example: its
  // `quality_flags` row shows the guard refused the model's text and `handoff()` served the
  // row, so the platform typed it. On the only occasion the model typed a pinned line
  // itself, it got it wrong. A near-copy is an UNREVIEWED sentence carrying an approved
  // one's meaning, and `reviewed_at` cannot see it because the gate is on the row, not on
  // what came back.
  //
  // This runs BEFORE the outbound guard on purpose. The model's text is discarded either
  // way, so guarding it would be guarding something nobody will send; and the row that
  // replaces it is reviewed Mongolian that the guard's own allow-list was built around —
  // literally, and it is worth spelling out because it is what makes skipping the guard
  // sound rather than convenient. `allowedNumbersFrom` runs over the sections whose
  // `origin` is `tenant`, `renderTenantSections` gives every section that origin, and since
  // D-058 the canned lines ARE one of those sections. So every numeral in every canned row
  // is in `allowed_numbers` by construction and a reviewed row cannot fail the numeral
  // guard. The exception is a snapshot published BEFORE D-058, where the canned section
  // still lives in the volatile tail and its numerals never reach the allow-list — that
  // tenant's rows are served unguarded here, exactly as the two short-circuits above
  // already serve them, so this changes nothing about that case either way.
  //
  // Nothing here EDITS a reply — `handleReception` holds that line and this keeps it. The
  // model's text is thrown away whole and the tenant's own row is served in its place,
  // exactly as the two short-circuits above do. The model keeps the job it is good at,
  // choosing which line applies, and loses the one it was measurably unreliable at.
  // A FAQ answer is pinned exactly like a canned row, and until 2026-09-21 it was not.
  //
  // Measured: the model reproduced the founder's damaged-hair FAQ and inserted «үзээд» —
  // «мастер үсчин ҮЗЭЭД зөвлөж өгнө» where the approved text says «мастер үсчин зөвлөж
  // өгнө». Nothing caught it, because `checkPinnedLines` only ever saw `canned_responses`.
  // That is D-065's rule reaching a table it had not reached: an approved sentence altered
  // is an unreviewed sentence carrying an approved one's meaning, whichever table it lives
  // in.
  //
  // Checked BEFORE the canned pinning so the more specific source wins attribution: a FAQ
  // answer and a canned row can share a closing sentence, and reporting a FAQ drift as
  // `canned_paraphrased` would send a reader to the wrong table (D-066).
  // EVERY price violation in what the model wrote is counted, whichever path the reply
  // then takes. Founder, 2026-09-24, on decision 3: *"Keep prices in the prompt, with the
  // guard. Count every violation, and I'll decide after Дали is live."* The guard below
  // only sees replies that reach it — a reply replaced by a FAQ answer, a pinned line or
  // the booking answer skips it, and a violation in that model text went uncounted. The
  // decision is about how often the MODEL misplaces a price, not about what was served,
  // so the count is taken here, on the model's own text, once per reply.
  const seenPrices = pricePresentation(result.text, input.serviceNames);
  if (seenPrices.violations.length > 0) {
    await deps.flag({
      code: PRICE_VIOLATION_FLAG,
      detail: `${seenPrices.violations.length} violation(s): `
        + [...new Set(seenPrices.violations.map((v) => v.kind))].sort().join(', ')
        + (seenPrices.ambiguous ? '; owner ambiguous' : ''),
      attempted: result.text,
    });
  }

  const faqDrift = faqAdaptation(result.text, input.faqAnswers);
  if (faqDrift !== null) {
    await deps.flag({
      code: 'faq_paraphrased',
      detail: `a FAQ answer was reproduced and altered; served the published text instead `
        + `(${faqDrift.run} characters shared)`,
      attempted: result.text,
    });
    const served = await d.draft({ body: faqDrift.answer, answeredBy: 'canned' });
    return served.ok
      ? { kind: 'drafted', outboundId: served.id, answeredBy: 'canned' }
      : { kind: 'retry', detail: served.detail };
  }

  const pinned = checkPinnedLines(result.text, input.canned);
  if (pinned.kind !== 'clean') {
    if (pinned.kind === 'paraphrase') {
      // Corrected AND counted. A paraphrase that is quietly fixed is a paraphrase nobody
      // knows is happening, and the rate is the only evidence about whether the gate
      // wording works at all.
      // HOW MUCH WAS DISCARDED, not only that something was.
      //
      // Serving the row replaces the WHOLE reply, which is right when the reply is that
      // line adapted and costly when the adapted line is one paragraph of three. D-077's
      // addendum accepted that cost — «the mechanism only means anything if it's exact» —
      // and the flag recorded no way to see how large it is.
      //
      // Measured on Matrix 2026-09-18 03:59: a 292-character reply was replaced by a
      // 108-character row, so 184 characters went, including the only sentence responsive
      // to what the customer had actually asked. Nothing in the corpus said so. A cost that
      // was stated rather than discovered still has to be COUNTED before anyone can judge
      // whether it is still the right trade.
      const replyChars = [...result.text].length;
      const rowChars = [...pinned.canonical].length;
      await deps.flag({
        code: 'canned_paraphrased',
        detail: `the reply is ${pinned.similarity.toFixed(3)} of "${pinned.canonicalKind}" and is not it; `
          + `served the row instead, discarding ${Math.max(0, replyChars - rowChars)} of ${replyChars} characters. `
          + `Attempted: ${result.text}`,
      });
    }
    const drafted = await d.draft({ body: pinned.canonical, answeredBy: 'canned' });
    return drafted.ok
      ? { kind: 'drafted', outboundId: drafted.id, answeredBy: 'canned' }
      : { kind: 'retry', detail: drafted.detail };
  }

  // ---- Advice the tenant's data does not give (`grounded_only`, 0041) -----
  //
  // Founder, 2026-09-24: *"If that isn't in the salon's knowledge base, it must not say
  // it."* Only where a rule the tenant marked `grounded_only` fired — Matrix's suitability
  // rules — because that is where the model gives advice, and ordinary connective prose is
  // in no document either. The refusal line written for the question is served instead,
  // opened by the price rows the reply quoted when the rule allows a price: the customer
  // asked about a service the salon sells, and its price is a fact the salon wrote.
  if (matched.grounded !== null) {
    const unsupported = ungroundedSentences(result.text, tenantRegion(input.promptStable, SECTION_LABELS.dataMarker));
    const refusal = canned(input.canned, matched.grounded.kind);
    if (unsupported.length > 0 && refusal !== null) {
      const prices = matched.grounded.quotePrice ? dataAnswer(result.text, input) : null;
      await deps.flag({
        code: 'advice_ungrounded',
        detail: `${unsupported.length} sentence(s) in no tenant row; served ${matched.grounded.kind}`
          + `${prices === null ? '' : ' with the quoted price rows'}: ${unsupported[0] ?? ''}`,
        attempted: result.text,
      });
      const served = await d.draft({
        body: prices === null ? refusal : `${prices}\n\n${refusal}`,
        answeredBy: prices === null ? 'canned' : 'deterministic',
      });
      return served.ok
        ? { kind: 'drafted', outboundId: served.id, answeredBy: prices === null ? 'canned' : 'deterministic' }
        : { kind: 'retry', detail: served.detail };
    }
  }

  // ---- The guard, then the draft ------------------------------------------

  const guarded = outboundGuard(
    input.tenantGuard,
    {
      firedGates: matched.firedGates,
      refusedTopicBlocksPrice: matched.refusedTopicBlocksPrice,
      priceBlockingTopics: matched.priceBlockingTopics,
      customerText: input.customerMessage,
    },
    result.text,
  );

  if (!guarded.ok) {
    // A gate label or a forbidden phrasing in a PRICED answer: the prices are still facts,
    // and the generic handoff is the one reply that answers nothing. Founder, 2026-09-24:
    // «Үс будуулахад хэд вэ?» *"must never get the generic handoff or leak a label"* — the
    // model had written the three colour rows correctly under «Ш2-т хамаарах…», and the
    // customer got «Уучлаарай, би энэ асуултад хариулж чадахгүй байна». The rows are served
    // from the price list, never the model's text. Only these two codes: every other
    // refusal is about the numbers themselves, or about a topic that must carry none.
    if (guarded.code === 'outbound_gate_label' || guarded.code === 'outbound_forbidden') {
      const fromData = dataAnswer(result.text, input);
      if (fromData !== null) {
        await deps.flag({
          code: guarded.code,
          detail: `${guarded.detail} [served: the quoted prices from the price list]`,
          attempted: result.text,
        });
        const served = await d.draft({ body: fromData, answeredBy: 'deterministic' });
        return served.ok
          ? { kind: 'drafted', outboundId: served.id, answeredBy: 'deterministic' }
          : { kind: 'retry', detail: served.detail };
      }
    }
    // The full attempted reply goes to the Quality layer. It is never edited and never
    // sent — an edited reply is an unreviewed reply.
    return handoff(d, input,
      { code: guarded.code, detail: guarded.detail, attempted: result.text },
      matched.matchedResponseKinds);
  }

  // One atomic send, capped in characters. A reply with no sentence boundary in reach
  // returns null rather than a half-sentence, and falls back like any other failure.
  const closing = canned(input.canned, 'closing') ?? '';
  const capped = capToSingleMessage(result.text, MAX_REPLY_CHARS, closing);
  if (capped === null) {
    return handoff(d, input,
      { code: 'outbound_length', detail: 'no sentence boundary within the cap', attempted: result.text },
      matched.matchedResponseKinds);
  }

  // Style rule (4) compliance, COUNTED not enforced. The founder approved the rule, it is
  // signed and published, and the model follows it intermittently — the same question
  // listed three prices one per line in one run and crammed them onto one line in the
  // next, on the same revision. D-065: an instruction to the model is a request until
  // something checks it. This does not edit the reply; the content is right and only its
  // shape is wrong, and discarding a correct answer over line breaks would be D-068 again.
  const lines = priceLineReport(capped.text);
  if (lines.violation) {
    await deps.flag({
      code: 'style_price_lines',
      detail: `rule (4): ${lines.total} price options, ${lines.maxPerLine} on one line`,
      attempted: capped.text,
    });
  }

  // Service-name fidelity, COUNTED not enforced. Three instructions have failed at this
  // (sh11's (11в), the signed (11ж), and the founder saying it in as many words), which is
  // D-065's rule arriving for the third time today: an instruction is a request until
  // something checks it. Enforcing would mean refusing an otherwise correct reply over a
  // name and sending the generic handoff — D-068's mistake in a new table — so the
  // ENFORCE-or-count decision is the founder's, and this is the rate he needs to make it.
  const names = serviceNameReport(capped.text, input.serviceNames);
  if (names.altered.length > 0) {
    await deps.flag({
      code: 'service_name_altered',
      detail: `renamed: ${names.altered.join(', ')}`,
      attempted: capped.text,
    });
  }

  // Price presentation, ENFORCED — and the only counter on this path that is.
  //
  // Founder, 2026-09-21: *"A price range built from two different services' prices must not
  // pass"* and *"a price is always shown with its exact service name from the data"*. The
  // measured instance is «Бүтэн будалт (дунд, урт зэргээс шалтгаалан): 176,000₮–200,000₮»:
  // two real prices welded into a spread no service has, under a name no service has.
  //
  // Why this one enforces where the two above only count: a rewritten name or a crammed
  // line is a reply that is RIGHT and badly dressed, and discarding it would be D-068. A
  // price against the wrong service is a reply that is WRONG, and a customer acts on it.
  //
  // The fallback is not the generic handoff — that is D-068 in the other direction, and it
  // lands on the question a customer asks when they are closest to booking. It is the price
  // list's own rows for the services whose prices were quoted: `gate/pinned.ts`'s move, one
  // table over. `answered_by` is `deterministic` because no model text survives and nothing
  // was spent choosing it (D-064: a `deterministic_replies` hit recorded as `canned` cannot
  // answer the first question anybody asks of the corpus).
  //
  // The cost is stated rather than discovered (D-077): serving the rows discards whatever
  // else the reply said, including a clarifying question that may have been good.
  // The booking apology, ENFORCED. Three instructions have failed at this, the third while
  // literally containing «УУЧЛАЛТ БҮҮ ГУЙ», so the founder's call is that the platform stops
  // it rather than asking a fourth time. Runs BEFORE the price check because it is the more
  // specific verdict: a booking reply's deposits are not service prices, so the price guard
  // would not fire on it anyway, and reporting this one as that one would send a reader to
  // the wrong question (D-066's re-attribution lesson).
  const bookingLine = canned(input.canned, 'booking_line');
  const apology = bookingApology(capped.text, bookingLine, apologyStemsFrom(input.canned));
  if (apology.apologises) {
    const answer = renderBookingAnswer(input.depositRows, bookingLine);
    if (answer !== null) {
      await deps.flag({
        code: 'booking_apology',
        detail: `the booking reply opened by apologising: ${apology.opening}`,
        attempted: capped.text,
      });
      const served = await d.draft({ body: answer, answeredBy: 'deterministic' });
      return served.ok
        ? { kind: 'drafted', outboundId: served.id, answeredBy: 'deterministic' }
        : { kind: 'retry', detail: served.detail };
    }
  }

  const presentation = pricePresentation(capped.text, input.serviceNames);
  if (presentation.violations.length > 0) {
    const kinds = [...new Set(presentation.violations.map((v) => v.kind))].sort().join(', ');
    const rowsText = renderQuotedRows(presentation.quoted);
    // The owner is unknowable, so the platform does not guess which service to serve. The
    // reply is loosely named and TRUE; substituting a list built from a shared price served
    // five unrelated services on the first real-model run, which is worse than the defect.
    if (presentation.ambiguous) {
      await deps.flag({
        code: 'outbound_price_presentation',
        detail: `${kinds}; owner ambiguous, reply left as written`,
        attempted: capped.text,
      });
      const asIs = await d.draft({ body: capped.text, answeredBy: 'model' });
      return asIs.ok
        ? { kind: 'drafted', outboundId: asIs.id, answeredBy: 'model' }
        : { kind: 'retry', detail: asIs.detail };
    }
    // An EMPTY substitution must never ship. `servicesFromPrefix` always populates `rows`
    // for a name it parsed, so this is unreachable from the live path — but "unreachable"
    // is what every dead guard in this repository was, and the failure mode here is a
    // customer receiving a blank message, which is worse than any wrong price. Found by a
    // test fixture carrying `rows: []`, not by reasoning.
    if (rowsText === '') {
      return handoff(d, input,
        { code: 'outbound_price_presentation', detail: `${kinds}; no price-list rows to serve`, attempted: capped.text },
        matched.matchedResponseKinds);
    }
    // A set the tenant presents as one — Matrix's colour rows — is served in the tenant's
    // order with its question, not in price-list order without it.
    const setRow = setRowFor(input.deterministic, presentation.quoted);
    const setBody = setRow === null ? null : composeQuoted(setRow, input.serviceNames);
    await deps.flag({
      code: 'outbound_price_presentation',
      detail: `${kinds}; served the price list's own rows for: `
        + presentation.quoted.map((q) => q.name).join(', ')
        + (setRow === null || setBody === null ? '' : ` [as ${setRow.intent}]`),
      attempted: capped.text,
    });
    const rows = await d.draft({ body: setBody ?? rowsText, answeredBy: 'deterministic' });
    return rows.ok
      ? { kind: 'drafted', outboundId: rows.id, answeredBy: 'deterministic' }
      : { kind: 'retry', detail: rows.detail };
  }

  // A correct set answer in the wrong order, or without its question. Founder, 2026-09-24:
  // *"«Үсний угийн будаг» first, then Дунд, then Урт, then my question."* Measured the same
  // day: «Будаг хэд вэ?» got the question FIRST and the rows in price-list order, with no
  // violation for the guard above to see. A reply already in the tenant's order is left
  // exactly as written; only one that is not is served as the set row.
  if (!presentation.ambiguous) {
    const setRow = setRowFor(input.deterministic, presentation.quoted);
    if (setRow !== null && !inSetOrder(capped.text, setRow)) {
      const setBody = composeQuoted(setRow, input.serviceNames);
      if (setBody !== null) {
        await deps.flag({ code: 'set_presentation', detail: `served ${setRow.intent} in the tenant's order`, attempted: capped.text });
        const served = await d.draft({ body: setBody, answeredBy: 'deterministic' });
        return served.ok
          ? { kind: 'drafted', outboundId: served.id, answeredBy: 'deterministic' }
          : { kind: 'retry', detail: served.detail };
      }
    }
    // The set's question under a price that is NOT in the set: «Сор хэд вэ?» was answered
    // with Сор's price and then «Та бүтэн будуулах уу, эсвэл үсний угийн будаг хийлгэх
    // үү?» — a question about colouring put to somebody who asked about Сор. The quoted
    // rows are served without it.
    const stray = setRows(input.deterministic).find((r) => r.body.trim() !== ''
      && fold(capped.text).includes(fold(r.body.trim()))
      && presentation.quoted.length !== 0
      && presentation.quoted.every((q) => !r.quoteServices.includes(q.name)));
    if (stray !== undefined) {
      const rowsOnly = renderQuotedRows(presentation.quoted);
      if (rowsOnly !== '') {
        await deps.flag({ code: 'set_question_stray', detail: `${stray.intent}'s question under ${presentation.quoted.map((q) => q.name).join(', ')}`, attempted: capped.text });
        const served = await d.draft({ body: rowsOnly, answeredBy: 'deterministic' });
        return served.ok
          ? { kind: 'drafted', outboundId: served.id, answeredBy: 'deterministic' }
          : { kind: 'retry', detail: served.detail };
      }
    }
  }

  // «Уучлаарай» only when the reply refuses something (see `guard/apology.ts`).
  const apologyStems = apologyStemsFrom(input.canned);
  const sorry = unwarrantedApology(capped.text, apologyStems, refusalMarkerFrom(input.canned, apologyStems),
    matched.matchedResponseKinds.length > 0);
  if (sorry.strip) {
    await deps.flag({ code: 'apology_removed', detail: `opened with «${sorry.removed}» and refused nothing`, attempted: capped.text });
  }

  const drafted = await d.draft({ body: sorry.strip ? sorry.text : capped.text, answeredBy: 'model' });
  return drafted.ok
    ? { kind: 'drafted', outboundId: drafted.id, answeredBy: 'model' }
    : { kind: 'retry', detail: drafted.detail };
}
