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
  composeQuoted, correctionFor, matchDeterministic, withAppended, type DeterministicRule, type HistoryState,
} from '../gate/deterministic.ts';
import { isTenantConfirmed } from '../provenance.ts';
import { REPLY_REMINDERS, appendedNotice } from './volatile.ts';
import { tenantRegion, ungroundedSentences } from '../guard/grounding.ts';
import { refusalMarkerFrom, unwarrantedApology } from '../guard/apology.ts';
import { fold } from '../mn/text.ts';
import type { CommentRule } from '../comments/classify.ts';
import { isComplaint } from '../sales/nextStep.ts';
import { SECTION_LABELS } from '../prompt/tenant.ts';
import { entriesFrom, matchService, termIsSpecific, termTokens, toTerm } from '../services/match.ts';
import { containsStem, findStem } from '../mn/match.ts';
import { IMAGE_REPLY_KIND } from '../inbound/imageReply.ts';
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
import { respell, type Spelling } from '../mn/latin.ts';
import { checkFacts, factSourceFrom } from '../guard/facts.ts';
import { instructionLeakIn } from '../quality/leaks.ts';
import {
  CLARIFY_BRANCH_KIND, branchSectionLabels, establishedBranches, termsForPrefix, type BranchStems,
} from '../branches/branches.ts';
import { branchFactSource, judgeBranches } from '../branches/facts.ts';

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
  /**
   * The customer sent a PHOTOGRAPH — an `image` attachment with no sticker id. Separate from
   * the kinds because a sticker declares `image` too (D-070), and a thumbs-up answered with
   * «I cannot see pictures» is worse than silence. Required, like the kinds, so a caller
   * cannot have "no photo" asserted on its behalf.
   */
  customerSentPhoto: boolean;
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
   * The tenant's reviewed callback line (`ReceptionContext.fallbackLine`), or null. Required
   * so a caller cannot forget it silently; null keeps the generic handoff line.
   */
  fallbackLine: string | null;
  /**
   * The tenant's complaint rows (`ReceptionContext.complaintRules`). Required for the same
   * reason as `fallbackLine`; `[]` means no message is read as a complaint.
   */
  complaintRules: readonly CommentRule[];
  /**
   * The service names the tenant's price list renders, for the name-fidelity COUNTER.
   *
   * Derived from `promptStable` by `servicesFromPrefix`, so it costs no query. Required
   * rather than defaulted: `[]` would silently mean "this tenant sells nothing", and a
   * caller that forgets would turn the counter off rather than fail — which is the shape
   * `customerAttachments` already refuses for the same reason.
   */
  serviceNames: readonly PricedService[];
  /** `service_aliases` by service name (D-117). Required: `[]` is a real state, and says so. */
  serviceAliases: readonly { name: string; alias: string }[];
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
  /**
   * The tenant's settled and confirmed Latin spellings (`spellings`, D-120). The gate and the
   * deterministic rows match against the message AND against it with these words replaced,
   * so «huuhdiin» reaches the children's rule once the list knows «хүүхдийн». Required:
   * `[]` is a real state — a tenant whose list is empty — and a caller must say so.
   */
  spellings: readonly Spelling[];
  /**
   * `tenant_branches` names and stems, read live — how a customer can name a branch (D-125).
   * Only read when the prefix lists two or more branches (`reception/load.ts`); `[]` for
   * every other tenant, and then nothing about branches runs here. Required: `[]` is a real
   * state and a caller must say so.
   */
  branches: readonly BranchStems[];
  /**
   * Today's and tomorrow's weekday on the tenant's clock (`ReceptionContext.days`), so hours
   * restated about ONE day are served as that day and not the week (D-126). Absent or null:
   * the week, as before.
   */
  days?: { today: number; tomorrow: number; closed?: readonly number[] } | null;
};

export type ReceptionOutcome =
  /** A reply row exists and is ready for the send path. */
  | { kind: 'drafted'; outboundId: string; answeredBy: AnsweredBy; refusal?: string }
  /** Could not determine something. The caller must 503 so QStash retries. */
  | { kind: 'retry'; detail: string }
  /** Determinate and unanswerable. ACK and stop; retrying cannot change it. */
  | { kind: 'dropped'; reason: string };

/** The tenant's pinned line for a kind, or null when it is not provisioned. */
/**
 * The line served when a reply must be replaced and no specific reviewed line applies: the
 * tenant's reviewed callback line if it has one, otherwise its handoff line (founder,
 * 2026-09-26: *"A customer who wants to buy must never be told we have no information. They
 * should get a real answer or the approved callback line."*). Measured on DalaTech's test
 * set the same night: «За тэгвэл Дали авъя», a price objection, «Имэйл хаяг чинь юу вэ» and
 * a two-staff total all ended on «…мэдээлэл надад байхгүй байна». Both lines are true for
 * any question, which is the property the generic line needs.
 */
function generalLine(input: Pick<ReceptionInput, 'canned' | 'fallbackLine'>): { body: string; kind: string } | null {
  const f = input.fallbackLine;
  if (typeof f === 'string' && f.trim() !== '') return { body: f, kind: 'sales_callback' };
  const h = canned(input.canned, 'handoff');
  return h === null ? null : { body: h, kind: 'handoff' };
}

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
 * The price-list rows of every service the customer's message NAMES, or null.
 *
 * Founder, 2026-09-24: «будагтай үсний уг цайруулалт хэд вэ» got «энэ үйлчилгээний үнийн
 * мэдээлэл надад байхгүй» — no price — while «Цайруулалт: 430,000₮–570,000₮» is on the list.
 * Repeated on the real model it refused on the OLD configuration too, and once quoted
 * Оффис колор for it instead: the model reads «уг цайруулалт» as a service that is not
 * listed. `matchService` asks the exact question: does every word of a listed name occur in
 * the message? «Цайруулалт» does; «Үсний угийн будаг» does not, «угийн» being absent.
 *
 * `unique` and `family` only — a family is D-102's answer, the named service and the longer
 * names containing it. Peers and vague matches are not evidence of which service was meant.
 */
function rowsNamedByCustomer(message: string, input: ReceptionInput): string | null {
  const entries = entriesFrom(input.serviceNames.map((s) => ({ id: s.name, name: s.name })), []);
  const m = matchService(message, entries);
  const names = m.verdict === 'unique' ? [m.match.name]
    : m.verdict === 'family' ? m.family.map((f) => f.name)
      : [];
  const rows = input.serviceNames.filter((s) => names.includes(s.name)).flatMap((s) => [...s.rows]);
  return rows.length === 0 ? null : rows.join('\n');
}

/**
 * The price-list rows that mention a word of the customer's message, whole services at a
 * time, or null.
 *
 * For a question about a TIER rather than a service — «Мастер үсчин илүү сайн уу?» — no
 * service is named, and the tier is written into the price list's own rows («Эмэгтэй
 * тайралт (Мастер): …»). Serving every row of each service that mentions it shows both
 * tiers side by side, which is the neutral answer: the difference is the level and the
 * price. Used only where the model's own reply cannot be sent; words shorter than the
 * gate's stem floor are ignored, because a short word matches everything.
 */
function rowsMentioningCustomerWords(message: string, input: ReceptionInput): string | null {
  // Folded here: `containsStem` folds the TEXT and takes the stem as given.
  const words = fold(message).split(/[^\p{L}\p{N}]+/u).filter((w) => [...w].length >= MIN_WORD_CP);
  const services = input.serviceNames.filter((s) => s.rows.some((row) => words.some((w) => containsStem(row, w))));
  const rows = services.flatMap((s) => [...s.rows]);
  return rows.length === 0 ? null : rows.join('\n');
}
/**
 * The longest reviewed canned row the reply contains whole, or null.
 *
 * Whole and exact after folding, never similar: D-077's rule for anything deciding whether an
 * approved sentence is present. The image line is excluded — it answers a picture, and a
 * text reply that happens to contain it was not answering one.
 */
function quotedRow(text: string, rows: readonly CannedRow[]): CannedRow | null {
  const reply = fold(text);
  const hits = rows.filter((r) => {
    const body = fold(r.body).trim();
    return r.reviewedAt !== null && r.kind !== IMAGE_REPLY_KIND && body !== '' && reply.includes(body);
  });
  // Longest first; a tie is broken by kind so two runs cannot disagree (D-026).
  hits.sort((a, b) => ([...b.body].length - [...a.body].length) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  return hits[0] ?? null;
}

/** The gate's stem floor, for the same reason: a three-letter word is in every other row. */
const MIN_WORD_CP = 4;

/** A service name's last word — its kind, in a head-final language: «Усан хими» is a хими. */
function headOf(name: string): string {
  const tokens = termTokens(name);
  const head = tokens[tokens.length - 1] ?? '';
  return [...head].length >= MIN_WORD_CP ? head : '';
}

/**
 * The price-list rows a suitability question is about, or null.
 *
 * Founder, 2026-09-24: *"list the relevant services with prices, then say the stylist
 * decides."* The customer writes «Budagtai usend himi hiidegv» and the model, told the
 * answer is the stylist's, often quotes no price at all — so the services are found here:
 * any listed service whose name, or one of whose `service_aliases`, occurs whole in the
 * text, and then every listed service of the same KIND (the same last word). «himi» is an
 * alias of «Эмчилгээний хими»; its kind is «хими»; the answer lists all four «… хими»
 * services, which is what a person would. «Хими арчилт» is an «арчилт», and is not listed.
 *
 * `texts` is a priority list, not a pool: the first text that names anything decides.
 * Pooled, the model's own advice chose rows — c07's reply said «хэт цайруулсан бол…», an
 * alias of «Цайруулалт» matched it, and a question about perming dyed hair was answered
 * with the price of bleaching. The customer's words come first; the reply is consulted only
 * when they name nothing.
 *
 * Kinds in the order the text first mentions them, the service it named leading its kind,
 * then the rest of the kind in price-list order — so «budaad … himi» lists the colour rows
 * before the perm rows, «Үсний угийн будаг» first among them as the salon orders it. Rows
 * verbatim: nothing here writes a price, it only chooses rows.
 */
function relevantRows(texts: readonly string[], input: ReceptionInput): string | null {
  const listed = new Set(input.serviceNames.map((s) => s.name));
  const terms = [
    ...input.serviceNames.map((s) => ({ name: s.name, term: s.name })),
    ...input.serviceAliases.filter((a) => listed.has(a.name)).map((a) => ({ name: a.name, term: a.alias })),
  ].map((t) => ({ name: t.name, term: toTerm(t.term) })).filter((t) => termIsSpecific(t.term));
  for (const text of texts) {
    const folded = fold(text);
    // Where each named service is first mentioned, in code points; a term counts only whole.
    const at = new Map<string, number>();
    for (const t of terms) {
      const starts = t.term.tokens.map((tok) => findStem(folded, tok)[0]?.startCp);
      if (starts.some((p) => p === undefined)) continue;
      const pos = Math.min(...(starts as number[]));
      at.set(t.name, Math.min(at.get(t.name) ?? pos, pos));
    }
    if (at.size === 0) continue;
    const named = [...at.entries()]
      .sort((a, b) => (a[1] - b[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([name]) => name);
    const order: string[] = [];
    for (const name of named) {
      if (!order.includes(name)) order.push(name);
      const kind = headOf(name);
      if (kind === '') continue;
      for (const s of input.serviceNames) if (headOf(s.name) === kind && !order.includes(s.name)) order.push(s.name);
    }
    const rows = order.flatMap((name) => [...(input.serviceNames.find((s) => s.name === name)?.rows ?? [])]);
    if (rows.length > 0) return rows.join('\n');
  }
  return null;
}

/** Digit runs of four or more, reduced to digits — the amounts in a row, never «1-р». */
function amounts(text: string): string[] {
  return [...text.matchAll(/\d[\d,  ]*\d/gu)].map((m) => m[0].replace(/[^\d]/gu, '')).filter((d) => d.length >= 4);
}

/**
 * A reply carrying the booking link without the deposits gets the deposits, just above it.
 *
 * Founder, 2026-09-24: *"«tsag zahialah» … must state Мастер 20,000₮ / 1-р зэрэг 10,000₮ plus
 * the booking link."* It did on seq 13, and on the next three runs it did not: once the
 * model wrote the booking line alone, once the pinned-line check served the booking row in
 * place of a reply that had named one deposit, once the model prefixed a pleasantry. Three
 * paths, one fact missing. So the rule sits where every path ends — the draft — and is a
 * property of the text: the reviewed booking line present, some deposit amount absent.
 * The rows are the compiled «УРЬДЧИЛГАА ТӨЛБӨР» section's own, verbatim; nothing is
 * reworded, and a reply that already states every deposit is left exactly as written.
 */
function withDeposits(body: string, bookingLine: string | null, depositRows: readonly string[]): string {
  if (bookingLine === null || depositRows.length === 0) return body;
  const line = bookingLine.trim();
  const at = body.indexOf(line);
  if (at === -1) return body;
  const have = new Set(amounts(body));
  if (depositRows.every((r) => amounts(r).every((a) => have.has(a)))) return body;
  const before = body.slice(0, at).trimEnd();
  const block = depositRows.map((r) => r.trim()).join('\n');
  return `${before === '' ? '' : `${before}\n\n`}${block}\n\n${body.slice(at)}`;
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
  if (line === null) {
    const general = generalLine(input);
    if (general !== null) { line = general.body; servedKind = general.kind; }
  }
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
  // The customer's words with the tenant's known Latin spellings replaced, as a SECOND text
  // every matcher also tries (D-120). Never shown to the model and never instead of the
  // original: a spelling can add a match, it cannot hide what the customer wrote.
  const respelled = respell(input.customerMessage, input.spellings);
  const matched = matchRules(
    { text: input.customerMessage, attachments: input.customerAttachments, respelled }, input.rules);
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
  const matchOpts = { hasAttachment: input.customerAttachments.length > 0, attachments: input.customerAttachments, topics: matched.matchedTopics, respelled };
  const shortcut = matchDeterministic(input.customerMessage, input.deterministic, input.historyState, matchOpts);
  // `append` rows (`0041`): whatever is served from here on, their bodies go at the END.
  // Founder, 2026-09-24: *"The Tara line must never replace an answer. Only a question about
  // the name gets the line on its own."* Every draft below goes through `d`, handoff
  // included, so no path can serve an answer without the line or the line without an answer.
  const appends = shortcut.appends;
  const bookingRow = canned(input.canned, 'booking_line');
  const previousReply = [...input.history].reverse().find((h) => h.role === 'assistant')?.content ?? null;
  // Prices, the address, phone numbers, hours and deposits come from the data, never from
  // the model's wording (founder, 2026-09-24; `guard/facts.ts`). Checked HERE, where every
  // draft passes, so no path the model's text can take reaches a customer unchecked.
  const approvedTexts = [
    ...input.canned.filter((c) => c.reviewedAt !== null).map((c) => c.body),
    ...input.faqAnswers,
    ...input.deterministic.filter((r) => r.enabled).map((r) => r.body),
    ...input.depositRows,
    // L4's own lines — today's hours, a closure notice — are data rendered per request. Not
    // the reminders: those are instructions to the model, never text a reply may carry.
    ...input.promptVolatile.split('\n').filter((l) => !REPLY_REMINDERS.includes(l)),
  ];
  // Two or more branches (D-125): each branch's own sections are fact sections too, and a
  // reply's branch facts are then judged against the branch the customer named. `null` for a
  // prefix that lists fewer than two — every tenant today — and then none of it runs.
  const branchSrc = branchFactSource(input.promptStable, approvedTexts);
  const factRows = factSourceFrom(
    input.promptStable,
    { priceList: SECTION_LABELS.priceList, deposits: SECTION_LABELS.deposits, hours: SECTION_LABELS.hours, contacts: SECTION_LABELS.contacts },
    approvedTexts,
    branchSrc === null ? [] : branchSrc.names.flatMap((name) => {
      const l = branchSectionLabels(name);
      return [
        { section: 'contact' as const, label: l.contacts },
        { section: 'hours' as const, label: l.hours },
        { section: 'price' as const, label: l.prices },
      ];
    }),
  );
  // The tenant's own tomorrow sentence, filled for today (`reception/daySlots.ts`): served in
  // place of the week when the model restates tomorrow's hours in its own words.
  const tomorrowRow = input.deterministic.find((r) => r.tomorrowSlots === true && r.enabled
    && r.placement === 'replace' && isTenantConfirmed(r.provenance));
  // A price row is corroborated by its service's aliases too (`FactSource.aliases`).
  const aliases: Record<string, string[]> = {};
  for (const a of input.serviceAliases) (aliases[fold(a.name).trim()] ??= []).push(fold(a.alias).trim());
  const facts = input.days === undefined || input.days === null ? { ...factRows, aliases }
    : { ...factRows, aliases, days: { ...input.days, tomorrowLine: tomorrowRow?.body.trim() ?? null } };
  const established = branchSrc === null ? null
    : establishedBranches(input.customerMessage, respelled, input.history, termsForPrefix(branchSrc.names, input.branches));
  // Price rows a set row covers are served the tenant's way — its order, then its question
  // (founder, 2026-09-24: *"…then my question, also when served from data."*). Any other
  // line in the answer keeps the served text as it was.
  const asSet = (served: string): string => {
    const lines = served.split('\n');
    const quoted = input.serviceNames.filter((sv) => sv.rows.some((r) => lines.includes(r)));
    const covered = lines.every((l) => quoted.some((sv) => sv.rows.includes(l)));
    const row = covered ? setRowFor(input.deterministic, quoted) : null;
    return (row === null ? null : composeQuoted(row, input.serviceNames)) ?? served;
  };
  const d: ReceptionDeps = {
    ...deps,
    draft: async (x0) => {
      let x = x0;
      // NEVER THE BOT'S OWN INSTRUCTIONS, UNLESS ASKED (founder, 2026-09-26). Measured live on
      // DalaTech's Page: «ci henbe» got «Дотоод зааврынхаа талаар хуваалцах боломжгүй». Not
      // edited — the handoff line, which is true for any question, and a flag.
      if (x.answeredBy === 'model') {
        const leak = instructionLeakIn(x.body, input.customerMessage, approvedTexts);
        const general = leak === null ? null : generalLine(input);
        if (leak !== null && general !== null) {
          await deps.flag({ code: 'internal_instruction_blocked', detail: `${leak}; served ${general.kind}`, attempted: x.body });
          x = { ...x, body: general.body, answeredBy: 'canned' };
        }
      }
      if (x.answeredBy === 'model') {
        const fact = checkFacts(x.body, facts, input.customerMessage);
        if (fact.restated) {
          await deps.flag({ code: 'fact_restated', detail: fact.detail, attempted: x.body });
          // A price no row can be shown to own gets the handoff line: the answer with no
          // facts in it. Never the model's wording, and never a guessed row.
          const served = fact.served === null ? generalLine(input)?.body ?? null : asSet(fact.served);
          if (served === null) return { ok: false, detail: 'fact_restated: no row to serve and no handoff line' };
          x = { ...x, body: served, answeredBy: fact.served === null ? 'canned' : 'deterministic' };
        }
      }
      // WHICH BRANCH (D-125). Judged on what the model wrote — or on the rows `checkFacts`
      // served in its place, which can be one branch's rows exactly as easily. A reviewed
      // line or a deterministic row is the tenant's own words and is not judged here.
      if (x0.answeredBy === 'model' && branchSrc !== null && established !== null) {
        const verdict = judgeBranches(x.body, branchSrc, established);
        if (verdict.kind === 'serve') {
          await deps.flag({ code: 'branch_facts_served', detail: verdict.detail, attempted: x0.body });
          x = { ...x, body: verdict.body, answeredBy: 'deterministic' };
        } else if (verdict.kind === 'ask' || verdict.kind === 'handoff') {
          // Ask which branch — with the tenant's REVIEWED line only. No reviewed line, or the
          // question already asked on the previous turn and still unanswered: the handoff
          // line, which names no branch. Never the reply that guessed one.
          const clarify = verdict.kind === 'ask' ? canned(input.canned, CLARIFY_BRANCH_KIND) : null;
          const askedLastTurn = clarify !== null && previousReply !== null
            && fold(previousReply).includes(fold(clarify).trim());
          const line = clarify !== null && !askedLastTurn ? clarify : canned(input.canned, 'handoff');
          const code = verdict.kind === 'handoff' ? 'branch_no_counterpart'
            : clarify === null ? 'branch_ask_unavailable'
              : askedLastTurn ? 'branch_ask_repeated'
                : 'branch_asked';
          await deps.flag({ code, detail: verdict.detail, attempted: x0.body });
          if (line === null) return { ok: false, detail: `${code}: no reviewed line to serve` };
          x = { ...x, body: line, answeredBy: 'canned' };
        }
      }
      // A topic append («the stylist decides») is not added to a reviewed line: the refusal
      // it would follow already says it, in the tenant's own words.
      // Append rows that read the REPLY (`in_reply`) can only be judged now that there is
      // one (founder, 2026-09-26: whenever a coming-soon staff member comes up, prices
      // included, the reply says so). A line the reply already carries is not added again.
      const own = x.answeredBy === 'canned' ? appends.filter((a) => a.onTopic !== true) : appends;
      const onReply = matchDeterministic(input.customerMessage, input.deterministic, input.historyState,
        { ...matchOpts, reply: x.body }).appends
        // Only rows the message alone did not fire: the rest were already judged above,
        // including an on-topic line deliberately left off a reviewed refusal.
        .filter((a) => a.body.trim() !== '' && !appends.some((b) => b.intent === a.intent || b.body.trim() === a.body.trim())
          && !fold(x.body).includes(fold(a.body.trim())));
      const body = withAppended(withDeposits(x.body, bookingRow, input.depositRows), [...own, ...onReply]);
      // A correction answered with the same reply is not sent (founder, 2026-09-24, live:
      // «us bish usnii himi» got «Буруу ойлголоо. Усан хими 132,000₮–154,000₮» — the same
      // answer it was correcting). Every path ends here, so no path can repeat itself.
      const correction = correctionFor(input.deterministic, input.customerMessage, body, previousReply);
      if (correction !== null) {
        await deps.flag({ code: 'correction_repeat_blocked', detail: `served ${correction.intent}`, attempted: body });
        return deps.draft({ ...x, body: correction.body, answeredBy: 'deterministic' });
      }
      return deps.draft({ ...x, body });
    },
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
  // A PHOTOGRAPH, captioned or not, gets the tenant's image line (founder, 2026-09-24: *"A
  // photo with any caption gets the photo line. Key on the attachment, not on the word
  // «зураг»."*). A photo with no caption was already answered this way by
  // `inbound/imageReply.ts` before it reached here; a captioned one came down to the model,
  // which cannot see it and answered the words alone — «iim bolgoj bolhu», *can you make it
  // like this*, is a question about the picture. `customerSentPhoto` excludes stickers, so a
  // thumbs-up with a word beside it is not a photograph (D-070). A tenant with no reviewed
  // image line keeps today's behaviour: the model answers the words.
  if (input.customerSentPhoto) {
    const imageLine = canned(input.canned, IMAGE_REPLY_KIND);
    if (imageLine !== null) {
      await deps.release();
      const drafted = await d.draft({ body: imageLine, answeredBy: 'canned' });
      return drafted.ok
        ? { kind: 'drafted', outboundId: drafted.id, answeredBy: 'canned' }
        : { kind: 'retry', detail: drafted.detail };
    }
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

  // «No price for this» when the customer NAMED a listed service is wrong, and the list's
  // own rows are served instead (see `rowsNamedByCustomer`). Never on a turn where a refusal
  // rule blocks prices: there, «no price» is the rule working.
  const unlistedRow = canned(input.canned, 'refusal_price_unlisted');
  const saysUnlisted = pinned.kind !== 'clean' ? pinned.canonicalKind === 'refusal_price_unlisted'
    : unlistedRow !== null && fold(result.text).includes(fold(unlistedRow));
  if (saysUnlisted && !matched.refusedTopicBlocksPrice) {
    const named = rowsNamedByCustomer(input.customerMessage, input);
    if (named !== null) {
      await deps.flag({ code: 'price_unlisted_overridden', detail: 'the customer named a listed service', attempted: result.text });
      const served = await d.draft({ body: named, answeredBy: 'deterministic' });
      return served.ok
        ? { kind: 'drafted', outboundId: served.id, answeredBy: 'deterministic' }
        : { kind: 'retry', detail: served.detail };
    }
  }

  // ---- Suitability questions (`grounded_only`, 0041) ----------------------
  //
  // Founder, 2026-09-24: *"When a customer asks whether a service can be done (dyed hair plus
  // perm, colour on black hair), list the relevant services with prices, then say the
  // stylist decides what suits their hair. Refuse only when the answer would be advice the
  // salon's data doesn't contain."*
  //
  // A reply is sent as written only when every judged sentence is the tenant's own words
  // (`guard/grounding.ts`) and it is not the rule's refusal. Otherwise the answer is the
  // prices — the ones the reply quoted, else the services the customer named — served from
  // the price list; the tenant's `on_topic` append row then adds «the stylist decides».
  // Only when there are no prices at all is the refusal line served, and only for advice:
  // the model refusing by itself falls through to the pinned-line check as before.
  // Set when a grounded answer to a «can it be done» question quoted no price: the rows the
  // customer's own words name, composed after the reply (see the end of this function).
  let groundedPrices: string | null = null;
  if (matched.grounded !== null) {
    const refusal = canned(input.canned, matched.grounded.kind);
    // ANY refusal row counts, not only this rule's own: c03 «Хар өнгөтэй үсэнд орох уу» was
    // answered with the photo-consultation refusal word for word, and a check that knew only
    // `refusal_suitability` let it through with no price. The exception is a row another rule
    // that fired on this message points at — that refusal was asked for, and stands.
    const others = matched.matchedResponseKinds.filter((k) => k !== matched.grounded?.kind);
    const refusalRow = pinned.kind !== 'clean'
      && (pinned.canonicalKind === 'handoff' || pinned.canonicalKind.startsWith('refusal_'));
    const refused = (pinned.kind !== 'clean' && pinned.canonicalKind === matched.grounded.kind)
      || (refusalRow && !others.includes(pinned.canonicalKind))
      || (refusal !== null && fold(result.text).includes(fold(refusal)));
    const unsupported = ungroundedSentences(result.text, tenantRegion(input.promptStable, SECTION_LABELS.dataMarker));
    if (refused || unsupported.length > 0) {
      const prices = matched.grounded.quotePrice
        ? dataAnswer(result.text, input) ?? relevantRows([input.customerMessage, result.text], input)
        : null;
      if (prices !== null) {
        await deps.flag({
          code: 'suitability_prices_served',
          detail: `${refused ? 'the reply refused' : `${unsupported.length} sentence(s) in no tenant row`}; served the prices`,
          attempted: result.text,
        });
        const served = await d.draft({ body: prices, answeredBy: 'deterministic' });
        return served.ok
          ? { kind: 'drafted', outboundId: served.id, answeredBy: 'deterministic' }
          : { kind: 'retry', detail: served.detail };
      }
      if (!refused && refusal !== null) {
        await deps.flag({
          code: 'advice_ungrounded',
          detail: `${unsupported.length} sentence(s) in no tenant row; served ${matched.grounded.kind}: ${unsupported[0] ?? ''}`,
          attempted: result.text,
        });
        const served = await d.draft({ body: refusal, answeredBy: 'canned' });
        return served.ok
          ? { kind: 'drafted', outboundId: served.id, answeredBy: 'canned' }
          : { kind: 'retry', detail: served.detail };
      }
    } else if (matched.grounded.quotePrice && dataAnswer(result.text, input) === null) {
      // The salon's own words, and no price. c07 «Budagtai usend himi hiidegv» — the
      // founder's own example of the question — was answered from «Химийн хориглох заалт»
      // exactly, and named no service's price. The answer stands; the prices the customer's
      // words point at are added after it. The CUSTOMER'S words only: that document says
      // «цайруулаагүй», and the reply is not evidence of which service was asked about.
      groundedPrices = relevantRows([input.customerMessage], input);
    }
  }

  if (pinned.kind !== 'clean') {
    // WHEN THE CHECK IS UNSURE, THE GENERAL LINE — never a specific approved line that may
    // answer a different question (founder, 2026-09-25, D-126 addendum). A near-copy of the
    // whole reply is certain («би» dropped from the handoff line, 0.992) and gets its row.
    // An adaptation found INSIDE a reply is not: «амралтын өдрийн тусгай хуваарийн мэдээлэл
    // надад байхгүй» scored 0.754 of the PRICE refusal because both share a frame and a
    // phone sentence, and the customer was told a holiday question had no price. The
    // tenant's handoff line is true for any question; a topic's refusal is true for one.
    const unsure = pinned.kind === 'paraphrase' && pinned.embedded === true && pinned.canonicalKind !== 'handoff';
    const general = unsure ? generalLine(input)?.body ?? null : null;
    const servedBody = general ?? pinned.canonical;
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
      await deps.flag({
        code: 'canned_paraphrased',
        detail: `the reply is ${pinned.similarity.toFixed(3)} of "${pinned.canonicalKind}" and is not it; `
          + `served ${general !== null ? 'the handoff line (unsure: an adaptation inside the reply)' : 'the row'} instead, `
          + `discarding ${Math.max(0, replyChars - [...servedBody].length)} of ${replyChars} characters. `
          + `Attempted: ${result.text}`,
      });
    }
    const drafted = await d.draft({ body: servedBody, answeredBy: 'canned' });
    return drafted.ok
      ? { kind: 'drafted', outboundId: drafted.id, answeredBy: 'canned' }
      : { kind: 'retry', detail: drafted.detail };
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
      // Founder, 2026-09-24: *"never answer with an unrelated line."* The generic handoff IS
      // one, to «Мастер үсчин илүү сайн уу?». So the prices the reply quoted, else the rows
      // the customer's own words point at — for a tier question, both tiers side by side.
      const fromData = dataAnswer(result.text, input);
      // A reviewed row the reply quotes whole is the answer the model chose, in bytes somebody
      // approved. Measured on «tsag zahialah»: «Ш3 хамааралтай тул booking_line бэлэн
      // хариултыг ашиглав.» and then the booking line, exact — the label refused it and the
      // customer got the handoff instead of the link. The row is served alone; the deposits
      // then follow it as they follow every booking line (`withDeposits`).
      const quoted = fromData === null ? quotedRow(result.text, input.canned) : null;
      if (quoted !== null) {
        await deps.flag({
          code: guarded.code,
          detail: `${guarded.detail} [served: quoted row ${quoted.kind}]`,
          attempted: result.text,
        });
        const served = await d.draft({ body: quoted.body, answeredBy: 'canned' });
        return served.ok
          ? { kind: 'drafted', outboundId: served.id, answeredBy: 'canned' }
          : { kind: 'retry', detail: served.detail };
      }
      const fromWords = fromData
        ?? (guarded.code === 'outbound_forbidden' ? rowsMentioningCustomerWords(input.customerMessage, input) : null);
      if (fromWords !== null) {
        await deps.flag({
          code: guarded.code,
          detail: `${guarded.detail} [served: price-list rows]`,
          attempted: result.text,
        });
        const served = await d.draft({ body: fromWords, answeredBy: 'deterministic' });
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
  // A complaint keeps its apology (founder, 2026-09-26), by the tenant's own complaint rows:
  // «…3 хоног хүлээлээ. Ямар муу үйлчилгээ вэ» lost «Уучлаарай» and was left opening on
  // «Хариу удсанд тань.», half a sentence.
  const sorry = unwarrantedApology(capped.text, apologyStems, refusalMarkerFrom(input.canned, apologyStems),
    matched.matchedResponseKinds.length > 0 || isComplaint(input.customerMessage, input.complaintRules, respelled));
  if (sorry.strip) {
    await deps.flag({ code: 'apology_removed', detail: `opened with «${sorry.removed}» and refused nothing`, attempted: capped.text });
  }

  const reply = sorry.strip ? sorry.text : capped.text;
  // Composed, never edited: the model's reply byte for byte, then rows from the price list —
  // `withAppended`'s move. Not when the two together would pass the one-message cap.
  const withPrices = groundedPrices === null ? null : `${reply.trimEnd()}\n\n${groundedPrices}`;
  const body = withPrices !== null && [...withPrices].length <= MAX_REPLY_CHARS ? withPrices : reply;
  if (body !== reply) {
    await deps.flag({ code: 'suitability_prices_added', detail: 'a grounded answer quoted no price; the named rows follow it', attempted: capped.text });
  }
  const drafted = await d.draft({ body, answeredBy: 'model' });
  return drafted.ok
    ? { kind: 'drafted', outboundId: drafted.id, answeredBy: 'model' }
    : { kind: 'retry', detail: drafted.detail };
}
