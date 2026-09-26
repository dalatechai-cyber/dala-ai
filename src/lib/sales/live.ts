/**
 * The sales line, LIVE (D-132): what `handleReception` adds to a reply for a tenant whose
 * `sales_playbooks.mode` is `live`.
 *
 * Founder, 2026-09-26: *"After Дали answers a DalaTech customer's question (price or
 * otherwise), it adds this follow-up … Only once per conversation, never on every message.
 * Not after a complaint, and not when the customer only greets or says thanks. The approved
 * demo / callback / lead_thanks lines still apply when the customer asks for a demo, a call,
 * or leaves a number."*
 *
 * ## The same decision the shadow has recorded since D-127
 *
 * WHEN is `nextStep.ts`'s `decide`, unchanged: no line under a complaint (the tenant's own
 * escalate rows), under a refusal or the handoff line, after a photograph, when the reply
 * asks the customer something, on small talk, on a stray key, or when a next step was already
 * offered. WHICH: a step whose intent words fired (`demo`, `callback`), else the tenant's
 * default (`follow_up`). So what goes live is exactly what the shadow measured, plus one thing
 * the shadow could not see: the tenant's `small_talk` list.
 *
 * ## "Once per conversation" is read from the conversation itself
 *
 * An earlier assistant turn that carries any enabled step's body, or any step's link, means a
 * next step was offered. The history is what the customer saw, and it is also what a reply
 * case carries, so the permanent tests exercise the same rule production runs.
 *
 * ## A number is answered, not sold to
 *
 * A customer who leaves a phone number gets the tenant's reviewed `lead_thanks` line and no
 * model call (`leadThanksFor`). Only a NEW number: one already given earlier in the
 * conversation is not thanked twice, and the model answers whatever else was asked. A tenant
 * whose `lead_route` is `none` takes no leads and never thanks for one.
 *
 * ## Only reviewed words
 *
 * A step whose row is unwritten or unreviewed adds nothing. Every sentence this can add is a
 * founder-approved row, served whole.
 */
import type { CannedRow } from '../gate/match.ts';
import type { DeterministicRule } from '../gate/deterministic.ts';
import type { CommentRule } from '../comments/classify.ts';
import { wholeMessageMatches } from '../mn/match.ts';
import { fold } from '../mn/text.ts';
import { detectPhones } from './phone.ts';
import { classifyReply, decide, rowState, stepHosts, type Playbook, type PlaybookStep } from './nextStep.ts';

export type SalesLine = { kind: string; body: string };

/** The enabled, reviewed row of a kind, or null. */
function reviewedStep(playbook: Playbook, kind: string): PlaybookStep | null {
  const s = playbook.steps.find((x) => x.kind === kind && x.enabled);
  return s === undefined || rowState(playbook.steps, s.kind) !== 'reviewed' || s.body === null ? null : s;
}

/** Did an earlier assistant turn already carry a next step — its words or its link? */
export function offeredEarlier(
  playbook: Playbook,
  history: readonly { role: 'user' | 'assistant'; content: string }[],
): boolean {
  const bodies = playbook.steps
    .filter((s) => s.enabled && s.kind !== 'lead_thanks' && s.kind !== 'related_service' && s.body !== null)
    .map((s) => fold(s.body as string).trim())
    .filter((b) => b !== '');
  const hosts = stepHosts(playbook.steps);
  return history.some((h) => {
    if (h.role !== 'assistant') return false;
    const said = fold(h.content);
    return bodies.some((b) => said.includes(b)) || hosts.some((host) => said.includes(host));
  });
}

/**
 * The customer left a NEW phone number: the tenant's reviewed thank-you line, or null.
 * Null for a tenant that takes no leads, has no reviewed line, or when the number was already
 * given earlier in the conversation.
 */
export function leadThanksFor(input: {
  playbook: Playbook | null;
  customerMessage: string;
  history: readonly { role: 'user' | 'assistant'; content: string }[];
  ownNumbers: readonly string[];
}): string | null {
  const pb = input.playbook;
  if (pb === null || pb.mode !== 'live' || pb.leadRoute === 'none') return null;
  const phones = detectPhones(input.customerMessage, input.ownNumbers);
  if (phones.length === 0) return null;
  const earlier = input.history.filter((h) => h.role === 'user')
    .flatMap((h) => detectPhones(h.content, input.ownNumbers)).map((p) => p.digits);
  if (phones.every((p) => earlier.includes(p.digits))) return null;
  const thanks = reviewedStep(pb, 'lead_thanks');
  return thanks === null ? null : (thanks.body as string).trim();
}

/**
 * The line to add after this reply, or null. Pure: every input is data the reply path
 * already holds.
 */
export function salesLineFor(input: {
  playbook: Playbook | null;
  customerMessage: string;
  respelled: string | null;
  customerSentPhoto: boolean;
  history: readonly { role: 'user' | 'assistant'; content: string }[];
  replyBody: string;
  canned: readonly CannedRow[];
  deterministic: readonly DeterministicRule[];
  complaintRules: readonly CommentRule[];
  ownNumbers: readonly string[];
}): SalesLine | null {
  const pb = input.playbook;
  if (pb === null || pb.mode !== 'live') return null;

  // The reply already carries a step (a callback row answered, the model gave the demo link):
  // offered by the reply itself, nothing to add.
  const reply = fold(input.replyBody);
  const carried = pb.steps.some((s) => s.enabled && s.kind !== 'lead_thanks' && s.kind !== 'related_service'
    && s.body !== null && fold(s.body).trim() !== '' && reply.includes(fold(s.body).trim()));
  if (carried) return null;

  const smallTalkRows = input.deterministic.filter((r) => r.enabled && r.placement === 'replace' && r.matchMode === 'whole_message');
  const facts = classifyReply({
    body: input.replyBody,
    refusal: false,
    canned: input.canned,
    smallTalkBodies: smallTalkRows.map((r) => r.body),
    hosts: stepHosts(pb.steps),
  });
  const decision = decide({
    playbook: pb,
    customerMessage: input.customerMessage,
    respelled: input.respelled,
    customerSentPhoto: input.customerSentPhoto,
    earlierCustomerMessages: input.history.filter((h) => h.role === 'user').map((h) => h.content),
    reply: facts,
    // A person holding the thread never reaches generation (H11 check 4).
    threadControl: 'unknown',
    offeredBefore: offeredEarlier(pb, input.history),
    leadBefore: false,
    // The related-service line is not part of what went live.
    relatedBefore: true,
    customerSmallTalk: smallTalkRows.some((r) => wholeMessageMatches(input.customerMessage, r.stems))
      || wholeMessageMatches(input.customerMessage, pb.smallTalk ?? []),
    complaintRules: input.complaintRules,
    ownNumbers: input.ownNumbers,
    serviceNames: [],
  });
  const v = decision.nextStep;
  if (v.verdict !== 'offer' || v.row !== 'reviewed') return null;
  const step = reviewedStep(pb, v.kind);
  return step === null ? null : { kind: v.kind, body: (step.body as string).trim() };
}

/**
 * The model's reply with every approved sales line it RETYPED removed (D-135). The platform
 * adds a sales line, once per conversation (`salesLineFor`); the model must not. Measured on
 * case 42: with the follow-up already in the conversation, the model copied it into its own
 * answer 2 runs in 15 — offering it a second time, and carrying «24/7» and «24», which the
 * numeral guard then refused, so a correct answer became the canned fallback.
 *
 * Exact lines of the reviewed follow-up only (twelve characters or more each), so a
 * sentence the model wrote itself is never touched. Only for a `live` playbook. Returns the
 * text unchanged when nothing was retyped, or when removing it would leave nothing.
 */
export function withoutSalesLines(text: string, playbook: Playbook | null): string {
  if (playbook === null || playbook.mode !== 'live') return text;
  const lines = playbook.steps
    // The FOLLOW-UP only: the callback, demo and thank-you lines are also legitimate
    // answers, and a model that writes «leave your number» to a buyer has answered.
    .filter((st) => st.kind === 'follow_up' && st.enabled && st.reviewed && st.body !== null)
    .flatMap((st) => (st.body as string).split('\n'))
    .map((l) => l.trim())
    .filter((l) => [...l].length >= 12)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const l of lines) out = out.split(l).join(' ');
  if (out === text) return text;
  out = out.split('\n').map((l) => l.replace(/[ \t]{2,}/gu, ' ').trim()).filter((l, i, all) => l !== '' || (i > 0 && all[i - 1] !== '')).join('\n').trim();
  return out === '' ? text : out;
}
