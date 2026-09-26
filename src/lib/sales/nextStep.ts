/**
 * The sales next step: WHEN a conversation would be offered one, and WHICH (D-127).
 *
 * Founder, 2026-09-26: *"Both bots become salespeople. Every chat should end with a next
 * step, without being pushy."* DalaTech offers its demo or asks for a name and a phone;
 * Tara offers booking (link and deposit) or asks for a phone so the salon can call back, and
 * suggests one related service where it fits. *"Propose all new Mongolian wording for my
 * approval, test on real traffic in shadow, and show me before anything goes live."*
 *
 * ## This file decides and writes nothing
 *
 * It is the decision only, as a pure function of what the caller hands it, so the same code
 * answers the live shadow hook (`sales/shadow.ts`, after a reply is drafted) and the
 * retrospective run over last week's real conversations (`scripts/sales/retro.ts`). Nothing
 * here can reach a customer: there is no body in the result, only a KIND and the state of the
 * tenant's row for it. The words are rows (`sales_next_steps`, `0051`), reviewed like any
 * other customer-visible sentence, and none is approved yet.
 *
 * ## A tenant is rows
 *
 * Which next steps a tenant has, which one is its default, which words in a customer's
 * message make another one fitter, and which services pair with which — every one of those
 * is a row. There is no tenant, vertical or slug anywhere below. DalaTech's «demo» and
 * Tara's «booking» are two rows of the same table with `is_default = true`.
 *
 * ## When, in the order it is checked
 *
 * Once per conversation, never twice, and never where it would be pushy or wrong:
 *
 *  1. no reply was drafted (a message stored and deliberately not answered) — nothing to end;
 *  2. a person holds or has held this thread — the staff are selling already;
 *  3. the customer complained, in this message or an earlier one — the tenant's own
 *     `comment_rules` escalate rows decide what a complaint is (the classifier stays rows,
 *     D-122); a sales line under a complaint is the worst thing this could do;
 *  4. the customer has already given a phone number — the next step happened, and what is
 *     owed is an acknowledgement (`lead_thanks`), not a second ask;
 *  5. a photograph was answered with the image line — the conversation is mid-question;
 *  6. the reply is a refusal or the handoff line — it already points at a person;
 *  7. the reply already carries a next step's link (the booking URL, the demo URL) —
 *     offered, by the reply itself, and counted as offered;
 *  8. a next step was offered earlier in this conversation;
 *  9. the reply asks the customer something — the next step waits for the answer, or it
 *     buries the question («Та аль химийг хийлгэх вэ?» then a booking link);
 * 10. small talk — the reply is one of the tenant's greeting / «who are you» rows, or the
 *     customer's message is matched whole by one (a «sain bnuu» the model answered itself);
 * 11. fewer than three letters in the message — «л» is a stray key, not a question;
 *
 * and otherwise the offer is made. Which one: a step whose `intent_matcher` fires on the
 * customer's message wins (lowest `priority` first); otherwise the tenant's default step.
 *
 * ## The related service is its own verdict
 *
 * One per conversation, on the turn the customer NAMES a listed service the tenant pairs
 * with another (`service_pairings`) — which need not be the turn the next step is offered on.
 * Silenced by the same hard reasons (1–6) and wrong moments (9–11); never twice.
 */
import { matcherFires, parseMatcher, type MatcherSpec } from '../gate/match.ts';
import { entriesFrom, matchService } from '../services/match.ts';
import { classifyComment, type CommentRule } from '../comments/classify.ts';
import { fold, nfc } from '../mn/text.ts';
import { detectPhones, type PhoneHit } from './phone.ts';

/** The quality_flags codes this instrument writes. Two, and nothing else. */
export const NEXT_STEP_FLAG = 'sales_next_step_shadow';
export const LEAD_FLAG = 'sales_lead_shadow';

/** `follow_up`: the default line after an answer when no step's intent fired (D-132). */
export type NextStepKind = 'demo' | 'booking' | 'callback' | 'follow_up';
/** `related_service` and `lead_thanks` are rows too, but never the next step itself. */
export type StepRowKind = NextStepKind | 'related_service' | 'lead_thanks';
/** `none`: the tenant takes no leads — its staff do not call back (Tara, 2026-09-26, `0053`). */
export type LeadRoute = 'founder_telegram' | 'tenant_telegram' | 'page_label' | 'none';

/**
 * What the tenant's row for a kind can say today. `unwritten` — the row exists with no body
 * (the kind is configured, the words are not). `unreviewed` — a body nobody has signed.
 * `reviewed` — sendable, the day sending exists. `missing` — no row at all.
 */
export type RowState = 'missing' | 'unwritten' | 'unreviewed' | 'reviewed';

export type PlaybookStep = {
  kind: StepRowKind;
  body: string | null;
  reviewed: boolean;
  priority: number;
  isDefault: boolean;
  /**
   * Parsed `intent_matcher`: one matcher, or a JSON array of them of which ANY firing counts
   * (the matcher language has `all_of` and no `any_of`, and a step's intent is naturally a
   * list — a stem set, a two-word sequence, the Latin spellings). Null: no intent words, and
   * the step is chosen only as the default.
   */
  intent: readonly MatcherSpec[] | null;
  /**
   * The link this step offers («https://app.dalatech.online»), or null. Data, like
   * `tenant_booking.booking_url`: it is how a reply that ALREADY carries the step is
   * recognised, before any body is written.
   */
  link: string | null;
  enabled: boolean;
};

export type Pairing = { serviceName: string; relatedName: string; confirmed: boolean };

export type Playbook = {
  /** `live` (D-132): the line is added to the reply. `shadow`: only recorded. */
  mode: 'off' | 'shadow' | 'live';
  /** Whole messages that are only a greeting or a thanks (`sales_playbooks.small_talk`). */
  smallTalk?: readonly string[];
  leadRoute: LeadRoute;
  steps: readonly PlaybookStep[];
  pairings: readonly Pairing[];
};

/**
 * What the served reply IS, classified once by `classifyReply` (live) or read from the
 * corpus (retrospective). The decision never reads reply text; it reads these facts.
 */
export type ReplyFacts =
  | { exists: false }
  | {
      exists: true;
      /** Reviewed canned kinds the reply contains whole. */
      cannedKinds: readonly string[];
      /** `handleReception` served its handoff for a refusal (`outcome.refusal`). */
      refusal: boolean;
      /** The reply ends by asking the customer something. */
      asksQuestion: boolean;
      /** The reply is exactly one of the tenant's small-talk rows (greeting, identity). */
      smallTalk: boolean;
      /** The reply carries a link one of the tenant's next steps carries. */
      carriesStepLink: boolean;
    };

export type DecisionInput = {
  playbook: Playbook;
  customerMessage: string;
  /** The message with the tenant's known Latin spellings replaced (D-120), or null. */
  respelled?: string | null;
  customerSentPhoto: boolean;
  /** The customer's EARLIER messages in this conversation, oldest first. */
  earlierCustomerMessages: readonly string[];
  reply: ReplyFacts;
  /** `conversations.thread_control`, or 'unreadable'. */
  threadControl: string;
  /** Has an earlier turn of this conversation already been offered a next step? */
  offeredBefore: boolean;
  /** Has an earlier turn already captured a lead? (From the flags, which outlive `history`.) */
  leadBefore: boolean;
  /** Has an earlier turn already been given a related-service suggestion? */
  relatedBefore?: boolean;
  /**
   * The customer's message is small talk by the tenant's OWN rows — it is matched whole by an
   * enabled `whole_message` deterministic row (a greeting, «who are you»). Computed by the
   * caller, because those rows are the tenant's data. A «hi» is not the moment to sell.
   */
  customerSmallTalk?: boolean;
  /** The tenant's `comment_rules` — only `escalate` rows are read. */
  complaintRules: readonly CommentRule[];
  /** The numbers the tenant publishes (`publishedNumbers`), never a lead. */
  ownNumbers: readonly string[];
  /** The price-list names, for the related-service suggestion. */
  serviceNames: readonly string[];
};

export type SkipReason =
  | 'no_reply'
  | 'person_in_thread'
  | 'complaint'
  | 'complaint_earlier'
  | 'lead_given'
  | 'lead_given_earlier'
  | 'image_line'
  | 'refusal_or_handoff'
  | 'already_offered'
  | 'reply_asks'
  | 'small_talk'
  | 'no_content'
  | 'no_step_configured';

export type NextStepVerdict =
  | { verdict: 'skip'; reason: SkipReason }
  /** The reply itself carried a step's link: offered, and counted as offered. */
  | { verdict: 'in_reply' }
  | {
      verdict: 'offer';
      kind: NextStepKind;
      /** Why this kind: its intent words fired, or it is the tenant's default. */
      chosenBy: 'intent' | 'default';
      row: RowState;
    };

/** One related service would be suggested: `from` was named, the tenant pairs `to` with it. */
export type RelatedVerdict = { from: string; to: string; confirmed: boolean; row: RowState };

export type LeadVerdict =
  | { detected: false }
  | {
      detected: true;
      /** «7600****», never the digits. */
      masked: readonly string[];
      /** The message carries words beside the number — a name, often. Not parsed. */
      withWords: boolean;
      /** The same lead was given earlier in this conversation. */
      repeat: boolean;
      route: LeadRoute;
      /** State of the tenant's acknowledgement row, for when sending exists. */
      thanksRow: RowState;
    };

export type Decision = { nextStep: NextStepVerdict; related: RelatedVerdict | null; lead: LeadVerdict; phones: readonly PhoneHit[] };

/** The state of the tenant's row for a kind. */
export function rowState(steps: readonly PlaybookStep[], kind: StepRowKind): RowState {
  const s = steps.find((x) => x.kind === kind && x.enabled);
  if (s === undefined) return 'missing';
  if (s.body === null || nfc(s.body).trim() === '') return 'unwritten';
  return s.reviewed ? 'reviewed' : 'unreviewed';
}

/** Is this a complaint, by the tenant's own escalate rows? A malformed rule counts as yes. */
export function isComplaint(text: string, rules: readonly CommentRule[], respelled: string | null = null): boolean {
  const escalate = rules.filter((r) => r.verdict === 'escalate');
  if (escalate.length === 0) return false;
  const c = classifyComment({ text, attachments: [], respelled }, escalate);
  // Fail towards NOT selling: a rule that cannot be read might have been the complaint one.
  return !c.ok || c.verdict === 'escalate';
}

/** Letters in the message other than the digits and separators of a phone. */
function hasWordsBesidesPhone(text: string): boolean {
  return /\p{L}{2,}/u.test(text);
}

/** The kinds that can be the next step itself. */
export function isOfferable(kind: StepRowKind): kind is NextStepKind {
  return kind === 'demo' || kind === 'booking' || kind === 'callback' || kind === 'follow_up';
}

/** The next-step kinds, ordered: intent-fired first by priority, then the default. */
function chooseStep(
  steps: readonly PlaybookStep[],
  message: string,
  respelled: string | null,
): { step: PlaybookStep; chosenBy: 'intent' | 'default' } | null {
  const offerable = steps.filter((s) => s.enabled && isOfferable(s.kind));
  const byPriority = [...offerable].sort((a, b) => (a.priority - b.priority) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  const subject = { text: message, attachments: [] as string[], respelled };
  const fired = byPriority.find((s) => s.intent !== null && s.intent.some((m) => matcherFires(subject, m)));
  if (fired !== undefined) return { step: fired, chosenBy: 'intent' };
  const dflt = byPriority.find((s) => s.isDefault);
  return dflt === undefined ? null : { step: dflt, chosenBy: 'default' };
}

/**
 * One related service, when the customer's message names exactly one listed service that
 * the tenant pairs with another listed one. Only a unique name counts — a family or a
 * vague match is not evidence of which service was meant (D-075, D-102).
 */
function relatedFor(
  playbook: Playbook,
  message: string,
  serviceNames: readonly string[],
): { from: string; to: string; confirmed: boolean } | null {
  if (playbook.pairings.length === 0 || serviceNames.length === 0) return null;
  const m = matchService(message, entriesFrom(serviceNames.map((n) => ({ id: n, name: n })), []));
  if (m.verdict !== 'unique' || !m.match.specific) return null;
  const listed = new Set(serviceNames);
  const pair = playbook.pairings.find((p) => p.serviceName === m.match.name && listed.has(p.relatedName));
  return pair === undefined ? null : { from: pair.serviceName, to: pair.relatedName, confirmed: pair.confirmed };
}

/** Fewer letters than this is a stray key («л»), not a message anybody can be sold to. */
export const MIN_CONTENT_LETTERS = 3;

export function decide(input: DecisionInput): Decision {
  const { playbook, reply } = input;
  const phones = detectPhones(input.customerMessage, input.ownNumbers);
  const earlierPhones = input.earlierCustomerMessages.flatMap((m) => detectPhones(m, input.ownNumbers));
  const leadEarlier = input.leadBefore || earlierPhones.length > 0;

  const lead: LeadVerdict = phones.length === 0
    ? { detected: false }
    : {
        detected: true,
        masked: phones.map((p) => p.masked),
        withWords: hasWordsBesidesPhone(input.customerMessage),
        repeat: phones.every((p) => earlierPhones.some((e) => e.digits === p.digits)),
        route: playbook.leadRoute,
        thanksRow: rowState(playbook.steps, 'lead_thanks'),
      };

  // The reasons that silence BOTH the next step and the related-service line, in order.
  const hard = ((): SkipReason | null => {
    if (!reply.exists) return 'no_reply';
    if (input.threadControl === 'human') return 'person_in_thread';
    if (isComplaint(input.customerMessage, input.complaintRules, input.respelled ?? null)) return 'complaint';
    if (input.earlierCustomerMessages.some((m) => isComplaint(m, input.complaintRules))) return 'complaint_earlier';
    if (phones.length > 0) return 'lead_given';
    if (input.customerSentPhoto || reply.cannedKinds.includes('image_received')) return 'image_line';
    if (reply.refusal || reply.cannedKinds.some((k) => k === 'handoff' || k.startsWith('refusal_'))) return 'refusal_or_handoff';
    return null;
  })();
  // The reasons that are about THIS turn being the wrong moment, checked after "already".
  const moment = ((): SkipReason | null => {
    if (!reply.exists) return null;
    if (reply.asksQuestion) return 'reply_asks';
    if (reply.smallTalk || input.customerSmallTalk === true) return 'small_talk';
    if ((input.customerMessage.match(/\p{L}/gu) ?? []).length < MIN_CONTENT_LETTERS) return 'no_content';
    return null;
  })();

  const nextStep = ((): NextStepVerdict => {
    if (hard !== null) return { verdict: 'skip', reason: hard };
    if (leadEarlier) return { verdict: 'skip', reason: 'lead_given_earlier' };
    if (reply.exists && reply.carriesStepLink) return { verdict: 'in_reply' };
    if (input.offeredBefore) return { verdict: 'skip', reason: 'already_offered' };
    if (moment !== null) return { verdict: 'skip', reason: moment };
    const chosen = chooseStep(playbook.steps, input.customerMessage, input.respelled ?? null);
    if (chosen === null) return { verdict: 'skip', reason: 'no_step_configured' };
    const kind = chosen.step.kind as NextStepKind;
    return { verdict: 'offer', kind, chosenBy: chosen.chosenBy, row: rowState(playbook.steps, kind) };
  })();

  // One related service per conversation, on the turn the customer NAMES a paired service —
  // which need not be the turn the next step is offered on. Never under a hard skip or at the
  // wrong moment; never twice.
  const pair = hard === null && moment === null && input.relatedBefore !== true
    ? relatedFor(playbook, input.customerMessage, input.serviceNames) : null;
  const related: RelatedVerdict | null = pair === null ? null
    : { ...pair, row: rowState(playbook.steps, 'related_service') };

  return { nextStep, related, lead, phones };
}

// ---- Classifying a served reply (live path) ---------------------------------------------

/**
 * Links in a text: `https://…`, `www.…`, or a bare host. Hosts are LATIN labels only, so a
 * Cyrillic sentence typed without a space after its full stop («салон.Та») is never read
 * as a host.
 */
const LINK = /(?:https?:\/\/)?(?:www\.)?((?:[\p{Script=Latin}\p{N}-]+\.)+\p{Script=Latin}{2,})(?:\/[^\s<>"'«»)]*)?/gu;

/** The hosts a tenant's next-step rows carry — «app.dalatech.online», «matrixecosalon.org». */
export function stepHosts(steps: readonly PlaybookStep[], extraTexts: readonly string[] = []): string[] {
  const texts = [
    ...steps.filter((s) => s.enabled && isOfferable(s.kind))
      .flatMap((s) => [s.link ?? '', s.body ?? '']),
    ...extraTexts,
  ];
  const hosts: string[] = [];
  for (const t of texts) {
    for (const m of nfc(t).matchAll(LINK)) {
      const host = fold(m[1] ?? '').replace(/^www\./u, '');
      if (host.includes('.') && !hosts.includes(host)) hosts.push(host);
    }
  }
  return hosts;
}

/**
 * Classify the reply that was actually drafted. Exact questions only (D-077): a reviewed
 * row is present when its folded body occurs whole; small talk is the body of a small-talk
 * row EXACTLY; a link is a host occurring in the folded reply.
 */
export function classifyReply(input: {
  body: string | null;
  refusal: boolean;
  canned: readonly { kind: string; body: string; reviewedAt: string | null }[];
  smallTalkBodies: readonly string[];
  hosts: readonly string[];
}): ReplyFacts {
  if (input.body === null) return { exists: false };
  const reply = fold(input.body);
  const trimmed = nfc(input.body).trim();
  const cannedKinds = input.canned
    .filter((c) => c.reviewedAt !== null && fold(c.body).trim() !== '' && reply.includes(fold(c.body).trim()))
    .map((c) => c.kind)
    .sort();
  // The last visible character, ignoring emoji and closing punctuation after it.
  const tail = trimmed.replace(/[\s\p{Extended_Pictographic}‍️)»"']+$/u, '');
  return {
    exists: true,
    cannedKinds,
    refusal: input.refusal,
    asksQuestion: tail.endsWith('?') || tail.endsWith('？'),
    smallTalk: input.smallTalkBodies.some((b) => nfc(b).trim() === trimmed),
    carriesStepLink: input.hosts.some((h) => reply.includes(h)),
  };
}

// ---- Parsing rows ----------------------------------------------------------------------

const STEP_KINDS: readonly StepRowKind[] = ['demo', 'booking', 'callback', 'related_service', 'lead_thanks', 'follow_up'];
const ROUTES: readonly LeadRoute[] = ['founder_telegram', 'tenant_telegram', 'page_label', 'none'];

export type RawPlaybook = {
  mode: unknown;
  lead_route: unknown;
  /** `sales_playbooks.small_talk`, when the caller read it. */
  small_talk?: unknown;
  steps: readonly Record<string, unknown>[];
  pairings: readonly Record<string, unknown>[];
};

/**
 * Rows to a `Playbook`, or a refusal naming the row. A malformed intent matcher makes the
 * WHOLE playbook unusable rather than skipping the step — a skipped intent silently turns a
 * «call me» into a booking link, and nothing would say so. In shadow that costs one
 * unrecorded reply; the caller logs the detail.
 */
export function parsePlaybook(raw: RawPlaybook): { ok: true; playbook: Playbook } | { ok: false; detail: string } {
  const mode = raw.mode === 'shadow' ? 'shadow' : raw.mode === 'off' ? 'off' : raw.mode === 'live' ? 'live' : null;
  if (mode === null) return { ok: false, detail: `sales_playbooks.mode ${String(raw.mode)}` };
  const route = ROUTES.find((r) => r === raw.lead_route);
  if (route === undefined) return { ok: false, detail: `sales_playbooks.lead_route ${String(raw.lead_route)}` };
  const steps: PlaybookStep[] = [];
  for (const r of raw.steps) {
    const kind = STEP_KINDS.find((k) => k === r['kind']);
    if (kind === undefined) return { ok: false, detail: `sales_next_steps.kind ${String(r['kind'])}` };
    let intent: MatcherSpec[] | null = null;
    const rawIntent = r['intent_matcher'];
    if (rawIntent !== null && rawIntent !== undefined) {
      const list: unknown[] = Array.isArray(rawIntent) ? rawIntent : [rawIntent];
      if (list.length === 0) return { ok: false, detail: `sales_next_steps ${kind}: an empty intent list matches nothing; use null` };
      intent = [];
      for (const m of list) {
        const p = parseMatcher(m);
        if (!p.ok) return { ok: false, detail: `sales_next_steps ${kind}: ${p.detail}` };
        intent.push(p.spec);
      }
    }
    steps.push({
      kind,
      body: typeof r['body'] === 'string' ? nfc(r['body']) : null,
      reviewed: r['reviewed_at'] !== null && r['reviewed_at'] !== undefined,
      priority: Number(r['priority'] ?? 100),
      isDefault: r['is_default'] === true,
      intent,
      link: typeof r['link'] === 'string' && r['link'].trim() !== '' ? nfc(r['link']).trim() : null,
      enabled: r['enabled'] !== false,
    });
  }
  const pairings: Pairing[] = raw.pairings
    .filter((p) => p['enabled'] !== false)
    .map((p) => ({
      serviceName: nfc(String(p['service_name'] ?? '')),
      relatedName: nfc(String(p['related_name'] ?? '')),
      confirmed: p['provenance'] === 'tenant_confirmed',
    }));
  const smallTalk = Array.isArray(raw.small_talk)
    ? raw.small_talk.filter((t): t is string => typeof t === 'string' && t.trim() !== '').map((t) => nfc(t)) : [];
  return { ok: true, playbook: { mode, smallTalk, leadRoute: route, steps, pairings } };
}

/** The flag details, as ids and kinds. Never text, never a digit of a phone. */
export function nextStepDetail(d: Decision, extra: Record<string, unknown>): Record<string, unknown> {
  const v = d.nextStep;
  const base: Record<string, unknown> = v.verdict === 'skip' ? { verdict: 'skip', reason: v.reason }
    : v.verdict === 'in_reply' ? { verdict: 'in_reply' }
      : { verdict: 'offer', kind: v.kind, chosen_by: v.chosenBy, row: v.row };
  const r = d.related;
  return {
    ...base,
    ...(r === null ? {} : { related: { from: r.from, to: r.to, confirmed: r.confirmed, row: r.row } }),
    ...extra,
  };
}

export function leadDetail(l: LeadVerdict & { detected: true }, extra: Record<string, unknown>): Record<string, unknown> {
  return { masked: [...l.masked], with_words: l.withWords, repeat: l.repeat, route: l.route, thanks_row: l.thanksRow, ...extra };
}
