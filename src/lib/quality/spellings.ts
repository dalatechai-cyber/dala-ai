/**
 * Grow a tenant's Latin-spelling list from what its customers actually wrote (D-120).
 *
 * Founder, 2026-09-24: *"Grow the Latin-spelling list from real customer messages, and
 * settle ambiguous words like «usnii» by context, or ask."*
 *
 * Every morning, each Latin word a customer wrote yesterday that the list does not know is
 * compared with the words the tenant's OWN text contains (the compiled prefix, the reviewed
 * lines, the deterministic replies) through `mn/latin.ts`'s lossy key:
 *
 *  - **one word fits** → `settled`, and it is applied to matching from the next message on;
 *  - **several fit, and one is the stem of the rest** («хими», «химий») → `settled` to the
 *    stem, which is what a stem matcher needed anyway;
 *  - **several fit and they are different words** («үсний», «усны») → the neighbouring word
 *    is tried: if exactly one candidate forms a pair the tenant's text contains, the PAIR is
 *    `settled` («usnii himi» → the pair that exists), and the single word is still `ask`,
 *    because the next customer may write it beside something else;
 *  - **nothing fits** → nothing is written. «bro», «ok» and «storpay» are not the tenant's
 *    words, and a list that grew with them would be noise.
 *
 * Nothing here ever overwrites a row. A `confirmed` or `rejected` row is the founder's
 * decision and a `settled` one is yesterday's evidence; a new message cannot outvote either.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  cyrillicKey, isCyrillicToken, isLatinToken, latinKeys, tokens, MIN_SPELLING_CP, type Spelling,
} from '../mn/latin.ts';
import { byCodePoint, cpLength, fold } from '../mn/text.ts';

/** The tenant's words by key, and every pair of adjacent words its text contains. */
export type Vocabulary = { byKey: Map<string, Set<string>>; pairs: Set<string> };

export function vocabularyFrom(texts: readonly string[]): Vocabulary {
  const byKey = new Map<string, Set<string>>();
  const pairs = new Set<string>();
  for (const text of texts) {
    // Line by line: a pair across a line break is two rows of a list, not a phrase.
    for (const line of text.split('\n')) {
      let prev: string | null = null;
      for (const t of tokens(line)) {
        const w = fold(t.token);
        if (!isCyrillicToken(w)) { prev = null; continue; }
        if (prev !== null) pairs.add(`${prev} ${w}`);
        prev = w;
        if (cpLength(w) < MIN_SPELLING_CP) continue;
        const key = cyrillicKey(w);
        if (key === null) continue;
        const set = byKey.get(key) ?? new Set<string>();
        set.add(w);
        byKey.set(key, set);
      }
    }
  }
  return { byKey, pairs };
}

/** The tenant's words this Latin token could be, in code-point order. */
export function candidatesFor(latin: string, vocab: Vocabulary): string[] {
  const out = new Set<string>();
  for (const k of latinKeys(latin)) for (const w of vocab.byKey.get(k) ?? []) out.add(w);
  return [...out].sort(byCodePoint);
}

/** The shortest candidate when it begins every other one: the stem the rest inflect. */
function commonStem(candidates: readonly string[]): string | null {
  const [first, ...rest] = candidates;
  if (first === undefined) return null;
  if (cpLength(first) < 4) return null;
  return rest.every((c) => c.startsWith(first)) ? first : null;
}

export type Proposal = {
  latin: string;
  status: 'settled' | 'ask';
  cyrillic: string | null;
  candidates: string[];
  evidence: string[];
  seen: number;
};

const MAX_EVIDENCE = 3;

/**
 * What the list should learn from these messages. Pure: `known` is every Latin key the
 * list already has, in any status, so nothing already decided is proposed again.
 */
export function proposeSpellings(
  messages: readonly string[],
  vocab: Vocabulary,
  known: ReadonlySet<string>,
): Proposal[] {
  type Seen = { evidence: string[]; seen: number; neighbours: { prev: string | null; next: string | null }[] };
  const seen = new Map<string, Seen>();
  for (const message of messages) {
    const toks = tokens(message).map((t) => fold(t.token));
    toks.forEach((tok, i) => {
      if (!isLatinToken(tok) || cpLength(tok) < MIN_SPELLING_CP || known.has(tok)) return;
      const s = seen.get(tok) ?? { evidence: [], seen: 0, neighbours: [] };
      s.seen += 1;
      if (s.evidence.length < MAX_EVIDENCE && !s.evidence.includes(message)) s.evidence.push(message);
      s.neighbours.push({ prev: toks[i - 1] ?? null, next: toks[i + 1] ?? null });
      seen.set(tok, s);
    });
  }

  const out: Proposal[] = [];
  const proposed = new Set<string>();
  const push = (p: Proposal): void => {
    if (known.has(p.latin) || proposed.has(p.latin)) return;
    proposed.add(p.latin);
    out.push(p);
  };

  for (const latin of [...seen.keys()].sort(byCodePoint)) {
    const s = seen.get(latin) as Seen;
    const candidates = candidatesFor(latin, vocab);
    if (candidates.length === 0) continue;
    const settledTo = candidates.length === 1 ? candidates[0] ?? null : commonStem(candidates);
    if (settledTo !== null) {
      push({ latin, status: 'settled', cyrillic: settledTo, candidates, evidence: s.evidence, seen: s.seen });
      continue;
    }
    // Different words. Try the neighbour: a pair the tenant's own text contains is context.
    for (const n of s.neighbours) {
      for (const side of ['next', 'prev'] as const) {
        const other = n[side];
        if (other === null || !isLatinToken(other)) continue;
        const otherWords = candidatesFor(other, vocab);
        const fits = candidates.flatMap((c) => otherWords
          .filter((o) => vocab.pairs.has(side === 'next' ? `${c} ${o}` : `${o} ${c}`))
          .map((o) => (side === 'next' ? `${c} ${o}` : `${o} ${c}`)));
        const unique = [...new Set(fits)];
        if (unique.length !== 1 || unique[0] === undefined) continue;
        push({
          latin: side === 'next' ? `${latin} ${other}` : `${other} ${latin}`,
          status: 'settled', cyrillic: unique[0], candidates: [], evidence: s.evidence, seen: 1,
        });
      }
    }
    push({ latin, status: 'ask', cyrillic: null, candidates, evidence: s.evidence, seen: s.seen });
  }
  return out;
}

export type SpellingRow = Spelling & { status: string };

export type GrowOutcome =
  | { ok: true; added: Proposal[]; asks: { latin: string; candidates: string[]; evidence: string[] }[] }
  | { ok: false; detail: string };

/**
 * Propose, write the new rows, and return every open question. Existing rows are never
 * touched: `ignoreDuplicates` makes a race with another run, or with the founder answering,
 * a no-op rather than an overwrite.
 */
export async function growSpellings(
  db: SupabaseClient,
  input: { tenantId: string; messages: readonly string[]; vocabularyTexts: readonly string[] },
): Promise<GrowOutcome> {
  const { data, error } = await db
    .from('spellings')
    .select('latin, status, candidates, evidence')
    .eq('tenant_id', input.tenantId);
  if (error) return { ok: false, detail: `spellings unreadable: ${error.message}` };
  const rows = (Array.isArray(data) ? data : []) as Record<string, unknown>[];
  const known = new Set(rows.map((r) => String(r['latin'] ?? '')));

  const proposals = proposeSpellings(input.messages, vocabularyFrom(input.vocabularyTexts), known);
  if (proposals.length > 0) {
    const { error: wErr } = await db.from('spellings').upsert(
      proposals.map((p) => ({
        tenant_id: input.tenantId, latin: p.latin, cyrillic: p.cyrillic, status: p.status,
        candidates: p.candidates, evidence: p.evidence, seen: p.seen,
      })),
      { onConflict: 'tenant_id,latin', ignoreDuplicates: true },
    );
    if (wErr) return { ok: false, detail: `spellings not written: ${wErr.message}` };
  }

  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
  const asks = [
    ...rows.filter((r) => r['status'] === 'ask')
      .map((r) => ({ latin: String(r['latin']), candidates: strings(r['candidates']), evidence: strings(r['evidence']) })),
    ...proposals.filter((p) => p.status === 'ask')
      .map((p) => ({ latin: p.latin, candidates: p.candidates, evidence: p.evidence })),
  ];
  return { ok: true, added: proposals, asks };
}

/** The rows matching applies: settled by the data, or confirmed by the founder. */
export function appliedSpellings(rows: readonly SpellingRow[]): Spelling[] {
  return rows
    .filter((r) => (r.status === 'settled' || r.status === 'confirmed') && r.cyrillic !== '')
    .map((r) => ({ latin: r.latin, cyrillic: r.cyrillic }));
}
