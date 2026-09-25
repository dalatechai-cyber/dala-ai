/**
 * A tenant with more than one location: which branch the customer means (D-122).
 *
 * Tara Salon (Matrix) is about to have two branches, each with its own address and map link
 * and possibly its own phone, hours and prices. A question whose answer depends on the branch
 * must be answered for the branch the customer means — and when they have not said, the bot
 * asks rather than guessing one branch or mixing two. A question whose answer is the same at
 * every branch is answered without asking.
 *
 * Everything here is pure: text and rows in, names out. The rows are `tenant_branches`
 * (0047); the compiled prefix carries the branch list and each branch's own sections
 * (`prompt/tenant.ts`), and this module reads them back the way `quality/serviceNames.ts`
 * reads the price list — from the prefix the model was given, so the two cannot disagree.
 *
 * ## A tenant with fewer than two branches never reaches any of this
 *
 * `branchNamesFromPrefix` returns what the «САЛБАРУУД» section lists, and that section is
 * rendered only for two or more confirmed branches. For every other tenant it returns `[]`,
 * the reply path builds no branch source, and nothing below runs.
 *
 * ## Rule 6
 *
 * Every comparison is over NFC-folded text with the Unicode token boundary `mn/match.ts`
 * uses. No `\b`, no `\w`, no `[a-z]`; lengths are code points.
 */
import { cpOffsets, fold } from '../mn/text.ts';
import { findStem } from '../mn/match.ts';
import { cyrillicKey, isCyrillicToken, isLatinToken, latinKeys } from '../mn/latin.ts';
import { MIN_STEM_CHARS } from '../gate/match.ts';
import { sectionRows } from '../quality/serviceNames.ts';
import { MIN_BRANCHES, SECTION_LABELS, branchHeading } from '../prompt/tenant.ts';

/**
 * The canned kind served when a reply depends on a branch the customer has not named.
 *
 * Registered by `0047` with NO tenant row. The sentence is customer-visible Mongolian and is
 * the founder's (`prompt/drafts/branch_clarify.mn.txt`); until a REVIEWED row exists the reply
 * path serves the handoff line instead. It is in `MODEL_INVISIBLE_KINDS`: the platform serves
 * it, the model is never asked to choose it, and inserting it must not move `canned_hash`.
 */
export const CLARIFY_BRANCH_KIND = 'clarify_branch';

/** The branch names a compiled prefix lists, in its order. `[]` for a one-location tenant. */
export function branchNamesFromPrefix(promptStable: string): string[] {
  const names = sectionRows(promptStable, SECTION_LABELS.branches).map((n) => n.trim()).filter((n) => n !== '');
  return names.length >= MIN_BRANCHES ? names : [];
}

/** The three sections a branch can have its own copy of, as the prefix heads them. */
export function branchSectionLabels(branch: string): { contacts: string; hours: string; prices: string } {
  return {
    contacts: branchHeading(SECTION_LABELS.contacts, branch),
    hours: branchHeading(SECTION_LABELS.hours, branch),
    prices: branchHeading(SECTION_LABELS.priceList, branch),
  };
}

export type BranchTerms = { name: string; terms: readonly string[] };

/** A branch as the request path reads it from `tenant_branches`: its name and its stems. */
export type BranchStems = { name: string; stems: readonly string[] };

/**
 * The terms for the branches THE PREFIX lists, with the live rows' stems where a row of that
 * name exists. The prefix decides which branches exist for this reply — it is what the model
 * was shown — and a live row renamed since the publish contributes nothing rather than a
 * branch the model has never heard of. A listed branch with no live row is still named by the
 * unique words of its name.
 */
export function termsForPrefix(names: readonly string[], live: readonly BranchStems[]): BranchTerms[] {
  return branchTerms(names.map((name) => ({ name, stems: live.find((b) => b.name === name)?.stems ?? [] })));
}

function tokensOf(text: string): string[] {
  return fold(text).split(/[^\p{L}\p{N}]+/u).filter((t) => t !== '');
}

/**
 * The words that name each branch, and ONLY that branch.
 *
 * A branch's `stems` (how customers write it, in either script) and every token of its name
 * that no other branch's name carries. Two exclusions, both about the same failure:
 *
 *  - **Shorter than four code points** (`MIN_STEM_CHARS`, the gate's floor). «төв» would
 *    reach «төвд», «төвийн» and every sentence mentioning a centre.
 *  - **Shared by two branches.** «салбар» is in both names and in nearly every question
 *    about location — «хэдэн салбартай вэ?», «хаана салбар байдаг вэ?». A word that names
 *    every branch establishes all of them, which switches the question off for exactly the
 *    messages it exists for. A stem two branches both list is dropped for the same reason.
 *
 * A branch left with no term can never be named, so the bot would ask for ever. The
 * compiler refuses to publish that (`prompt/sections.ts`), rather than letting it loop.
 */
export function branchTerms(branches: readonly { name: string; stems: readonly string[] }[]): BranchTerms[] {
  const candidates = branches.map((b) => [...new Set([
    ...b.stems.map((s) => fold(s).trim()),
    ...tokensOf(b.name),
  ])].filter((t) => t !== '' && [...t].length >= MIN_STEM_CHARS));
  const owners = new Map<string, number>();
  for (const list of candidates) for (const t of list) owners.set(t, (owners.get(t) ?? 0) + 1);
  // The same word across SCRIPTS. `salbar` given as one branch's stem is «салбар», which is
  // in every branch's name — so it is as shared as the Cyrillic word, and a Latin «salbar
  // haana ve» must not settle the branch. D-120's lossy key («салбар» and `salbar` are one
  // key) is what says so; every name token counts, however short, because a shared word
  // is shared whatever its length.
  const keyOwners = new Map<string, Set<number>>();
  branches.forEach((b, i) => {
    for (const t of [...tokensOf(b.name), ...(candidates[i] ?? [])]) {
      for (const k of keysOf(t)) keyOwners.set(k, (keyOwners.get(k) ?? new Set()).add(i));
    }
  });
  return branches.map((b, i) => ({
    name: b.name,
    // Code-point order, so two runs over the same rows agree (D-026).
    terms: (candidates[i] ?? [])
      .filter((t) => owners.get(t) === 1 && keysOf(t).every((k) => (keyOwners.get(k)?.size ?? 0) <= 1))
      .sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)),
  }));
}

/** A single word's lossy key(s), in whichever script it is written; none for a phrase. */
function keysOf(term: string): string[] {
  if (/\s/u.test(term)) return [];
  if (isCyrillicToken(term)) {
    const k = cyrillicKey(term);
    return k === null ? [] : [k];
  }
  return isLatinToken(term) ? latinKeys(term) : [];
}

/** The branches a text names, in branch order. A term matches at the start of a token. */
export function namedIn(text: string, respelled: string | null, terms: readonly BranchTerms[]): string[] {
  const texts = [text, ...(respelled === null ? [] : [respelled])].map(fold);
  const offsets = texts.map(cpOffsets);
  return terms
    .filter((b) => b.terms.some((t) => texts.some((x, i) => findStem(x, t, offsets[i]).length > 0)))
    .map((b) => b.name);
}

/**
 * Which branch this turn is about, as far as the CUSTOMER has said.
 *
 * The current message first: a customer who names a branch now means that branch now. When
 * it names none, the latest earlier CUSTOMER turn that names one — «Яармаг» in answer to the
 * bot's own question, followed by «утас нь?». The bot's turns are not evidence: a branch the
 * bot mentioned is not one the customer chose.
 *
 * `from` matters to what happens next (see `judgeBranches`): a branch named in THIS message
 * is an instruction, and a reply about another branch is corrected to it; a branch named
 * earlier is only context, and a reply about another branch may be answering «what about
 * the other one?» — so that case asks rather than overriding the model.
 */
export type Established = { branches: string[]; from: 'message' | 'history' | 'none' };

export function establishedBranches(
  message: string,
  respelled: string | null,
  history: readonly { role: 'user' | 'assistant'; content: string }[],
  terms: readonly BranchTerms[],
): Established {
  const now = namedIn(message, respelled, terms);
  if (now.length > 0) return { branches: now, from: 'message' };
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const turn = history[i];
    if (turn === undefined || turn.role !== 'user') continue;
    const then = namedIn(turn.content, null, terms);
    if (then.length > 0) return { branches: then, from: 'history' };
  }
  return { branches: [], from: 'none' };
}
