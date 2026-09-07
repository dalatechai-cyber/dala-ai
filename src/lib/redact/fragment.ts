/**
 * The shortest fragment of a customer cluster that is safe to put in a Telegram message.
 *
 * ## The rule this implements, and where it came from
 *
 * The founder's instruction for the gap report, 2026-09-07: *shortest distinguishing
 * fragment, never a whole conversation, never a PSID, never a phone number or name a
 * customer typed. If a cluster can't be understood from a fragment, the report says so and
 * points at `kb_change_proposals` — the detail lives in the database, not in a chat app.*
 *
 * That last clause is the important one and it is why this returns a REFUSAL rather than a
 * best effort. A redactor that always produces something will, on the day it cannot find a
 * safe fragment, produce an unsafe one.
 *
 * ## Why the safety comes from sharing rather than from a blocklist
 *
 * The naive approach is to detect and strip names and phone numbers. Over Mongolian that
 * is the input-filter fallacy `guard/outbound.ts` already rejects: there is no reliable
 * deny-list of names, and a filter that catches nine in ten is worse than none because it
 * is trusted.
 *
 * So the fragment is never taken from one customer's message. It is taken from what a
 * cluster's messages have IN COMMON, across **distinct customers**. A term that two
 * different people both typed is, structurally, not either person's name, phone number or
 * booking reference — it is the thing they were both asking about, which is exactly what
 * the report is for. The privacy property falls out of the definition rather than being
 * bolted to it.
 *
 * Two backstops on top, because "structurally" is an argument and arguments have edges:
 *
 *   * **any run of `MAX_DIGIT_RUN` digits disqualifies a term.** A PSID is ~16 digits, a
 *     Mongolian mobile number is 8, a booking reference is digits. Two customers quoting
 *     the salon's own number would otherwise pass the sharing test.
 *   * **a length cap.** A "fragment" of 80 characters is a sentence, and a sentence a
 *     customer typed is the thing we are not sending.
 *
 * ## Nothing here decides anything a customer sees
 *
 * This runs over stored messages after the fact, to choose what a report says. A wrong
 * answer costs an unreadable line in Telegram or a fragment withheld — never a refused
 * customer, and never a word added to a prompt.
 */
import { cpLength, nfc } from '../mn/text.ts';

/** A PSID is ~16 digits; a Mongolian mobile is 8; a deposit is 5. Four is comfortably below. */
export const MAX_DIGIT_RUN = 4;

/** Beyond this a fragment is a sentence somebody typed, not a term they used. */
export const MAX_FRAGMENT_CP = 40;

/** Below this a term carries no meaning — `MIN_STEM_CHARS`'s reasoning, same as the gate. */
export const MIN_FRAGMENT_CP = 3;

export type CustomerMessage = {
  /** Any stable per-customer key. NEVER emitted — used only to count distinct people. */
  customerKey: string;
  text: string;
};

export type FragmentSpec = {
  /**
   * How many DISTINCT customers must have used a term before it may be quoted. Two is the
   * floor the privacy argument rests on; a caller wanting a stronger claim raises it.
   */
  minCustomers?: number;
  /**
   * Terms too common to distinguish anything — greetings, particles. Mongolian that lives
   * in a row rather than in this file, for the reason the central test gives: per-tenant
   * language in code is the design being wrong.
   */
  stopwords?: readonly string[];
};

export type FragmentResult =
  /** Safe to quote: shared by at least `minCustomers` distinct people. */
  | { ok: true; fragment: string; customers: number }
  /**
   * No safe fragment. The report must say so and point at the proposal row rather than
   * quoting anything — `reason` is for the operator, not for the customer-facing line.
   */
  | { ok: false; reason: 'no_messages' | 'too_few_customers' | 'no_shared_term' };

const DIGIT_RUN = new RegExp(`[0-9\\u0966-\\u096F]{${MAX_DIGIT_RUN},}`, 'u');

/**
 * Split on everything that is not a letter. Unicode property escapes, never `\w` or
 * `[a-z]` — rule 6. `\p{L}` keeps Cyrillic and Latin and drops digits, punctuation and the
 * separators Meta's clients insert.
 */
function terms(text: string): string[] {
  return nfc(text).toLowerCase().split(/[^\p{L}]+/u).filter((t) => t !== '');
}

function disqualified(term: string, stop: ReadonlySet<string>): boolean {
  const len = cpLength(term);
  return len < MIN_FRAGMENT_CP
    || len > MAX_FRAGMENT_CP
    || DIGIT_RUN.test(term)          // belt: `terms()` already drops digits, and this stays
    || stop.has(term);               //   in case the splitter is ever loosened
}

/**
 * The shortest term shared by the most distinct customers.
 *
 * Ranking: distinct customers descending, then code-point length ascending ("shortest"),
 * then code point order. The last key is not cosmetic — two terms tying on both counts must
 * resolve the same way on every machine, or the same cluster produces a different report in
 * CI and in production. `check-deterministic-order.mjs` forbids `localeCompare` for exactly
 * this class of ordering.
 */
export function safeFragment(messages: readonly CustomerMessage[], spec: FragmentSpec = {}): FragmentResult {
  const minCustomers = spec.minCustomers ?? 2;
  const stop = new Set((spec.stopwords ?? []).map((s) => nfc(s).toLowerCase()));

  if (messages.length === 0) return { ok: false, reason: 'no_messages' };

  const distinctCustomers = new Set(messages.map((m) => m.customerKey)).size;
  if (distinctCustomers < minCustomers) return { ok: false, reason: 'too_few_customers' };

  // Per term, the set of customers who used it — a customer who repeats a word ten times
  // still counts once, or one persistent person would manufacture a "shared" term.
  const byTerm = new Map<string, Set<string>>();
  for (const m of messages) {
    for (const t of new Set(terms(m.text))) {
      if (disqualified(t, stop)) continue;
      const seen = byTerm.get(t) ?? new Set<string>();
      seen.add(m.customerKey);
      byTerm.set(t, seen);
    }
  }

  let best: { fragment: string; customers: number } | null = null;
  for (const [term, customers] of byTerm) {
    if (customers.size < minCustomers) continue;
    if (best === null) { best = { fragment: term, customers: customers.size }; continue; }
    if (customers.size !== best.customers) {
      if (customers.size > best.customers) best = { fragment: term, customers: customers.size };
      continue;
    }
    const a = cpLength(term);
    const b = cpLength(best.fragment);
    if (a !== b) { if (a < b) best = { fragment: term, customers: customers.size }; continue; }
    if (term < best.fragment) best = { fragment: term, customers: customers.size };  // ascii-safe: code points
  }

  return best === null ? { ok: false, reason: 'no_shared_term' } : { ok: true, ...best };
}
