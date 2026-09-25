/**
 * Does a reply state a fact that belongs to one branch, and is that the branch the customer
 * means? (D-125)
 *
 * `guard/facts.ts` makes sure a price, an address, a phone or the hours come from the data
 * rather than the model's wording. With two branches that is no longer enough: Яармаг's
 * address, quoted perfectly from its own row, is still the wrong answer for a customer
 * asking about the other branch — and to a customer who has not said which, it is a guess
 * presented as a fact. This module asks the second question, as a property of the text, the
 * way `guard/facts.ts` asks the first.
 *
 * ## What counts as stating a branch's fact
 *
 * Read from the branch's own sections of the compiled prefix — its contacts, its week and its
 * prices, which `prompt/tenant.ts` renders only where they DIFFER between branches. A reply
 * states branch B's fact when it carries:
 *
 *  - one of B's rows, whole;
 *  - an amount (a price, a phone, a clock time) that only some branches' rows carry — an
 *    amount every branch carries, or one a tenant-wide row carries, identifies no branch;
 *  - B's phone written with the model's own separators («7600-1888»);
 *  - twelve code points of B's address (`ADDRESS_OVERLAP_CP`, the facts guard's own bound);
 *  - one of B's links.
 *
 * Text the platform already approved is masked first — the reviewed canned lines, the FAQ
 * answers, deterministic replies, deposit rows, today's L4 lines — so a handoff line carrying
 * the salon's phone never reads as the model choosing a branch. Those are the tenant's own
 * words, and a tenant that writes one branch's address into a FAQ answer has chosen to.
 *
 * ## The verdict
 *
 *  - No branch fact: `pass`. A question whose answer is the same everywhere is not asked about.
 *  - Branch facts, and the customer has named no branch, now or earlier: `ask`.
 *  - Every stated branch fact belongs to a branch the customer named: `pass`.
 *  - A fact of ANOTHER branch, and the customer named exactly one branch IN THIS MESSAGE:
 *    `serve` — that branch's own rows for the same facts, verbatim. The customer said which;
 *    the model answered about the other one, or mixed the two.
 *  - A fact of another branch otherwise (the branch was named earlier, or several were):
 *    `ask`. «What about the other one?» names no branch and means a different one, so the
 *    platform does not overrule the model with a branch from three turns ago — it asks.
 *  - `handoff` when a counterpart row does not exist: the other branch has an address row and
 *    this one has none. Never a guess.
 *
 * Nothing here edits a reply. `serve` replaces it whole with rows, as `guard/facts.ts` does.
 */
import { fold } from '../mn/text.ts';
import { blankUrls, canonicalizeUrl, extractUrls } from '../mn/extract.ts';
import { ADDRESS_OVERLAP_CP, amountsIn } from '../guard/facts.ts';
import { sectionRows } from '../quality/serviceNames.ts';
import { CONTACT_KIND_LABELS, SECTION_LABELS } from '../prompt/tenant.ts';
import { branchNamesFromPrefix, branchSectionLabels, type Established } from './branches.ts';

export type BranchRowSection = 'contact' | 'hours' | 'price';

export type BranchRow = {
  branch: string;
  section: BranchRowSection;
  /** The row as the prefix writes it, dash stripped — what is served. */
  text: string;
  /** What the row is ABOUT: the text before «: », so another branch's row for the same
   *  thing can be found («Хаяг», «Даваа», «Эмэгтэй тайралт (Мастер)»). */
  label: string;
  folded: string;
  amounts: string[];
  /** Links in the row, canonical and folded. */
  urls: string[];
  /** The address value, folded, when this is the address row. */
  address: string | null;
};

export type BranchFactSource = {
  /** Branch names, in the prefix's order. */
  names: string[];
  rows: BranchRow[];
  /** Amounts a TENANT-WIDE fact row carries: true everywhere, so no branch's. */
  sharedAmounts: ReadonlySet<string>;
  sharedUrls: ReadonlySet<string>;
  sharedAddresses: readonly string[];
  /** Approved text, folded, longest first — masked before anything is attributed. */
  approved: readonly string[];
};

function labelOf(row: string): string {
  const colon = row.indexOf(': ');
  return (colon === -1 ? row : row.slice(0, colon)).trim();
}

function valueOf(row: string): string {
  const colon = row.indexOf(': ');
  return colon === -1 ? '' : row.slice(colon + 2).trim();
}

function linksIn(text: string): string[] {
  return extractUrls(text).map((u) => canonicalizeUrl(u)).filter((u): u is string => u !== null).map(fold);
}

const ADDRESS_LABEL = CONTACT_KIND_LABELS['address'] ?? '';

/**
 * The branch rows of a compiled prefix, and what the tenant-wide rows make un-attributable.
 * `null` for a prefix that is not split by branch — every tenant with fewer than two.
 */
export function branchFactSource(promptStable: string, approved: readonly string[]): BranchFactSource | null {
  const names = branchNamesFromPrefix(promptStable);
  if (names.length === 0) return null;

  const rows: BranchRow[] = [];
  for (const branch of names) {
    const labels = branchSectionLabels(branch);
    for (const [section, label] of [['contact', labels.contacts], ['hours', labels.hours], ['price', labels.prices]] as const) {
      for (const text of sectionRows(promptStable, label)) {
        // A row with no value — a service shown with no figure because this branch's price
        // is unconfirmed — is the service's NAME, not a fact: a reply naming the service has
        // stated nothing about a branch. Left out, it also has no counterpart, so a reply
        // quoting the other branch's price for it is handed off rather than corrected to a
        // number this branch does not have.
        if (valueOf(text) === '') continue;
        const rowLabel = labelOf(text);
        rows.push({
          branch, section, text, label: rowLabel, folded: fold(text).trim(),
          amounts: amountsIn(text).map((a) => a.digits),
          urls: linksIn(text),
          address: section === 'contact' && rowLabel === ADDRESS_LABEL ? fold(valueOf(text)) : null,
        });
      }
    }
  }

  const shared = [
    ...sectionRows(promptStable, SECTION_LABELS.priceList),
    ...sectionRows(promptStable, SECTION_LABELS.deposits),
    ...sectionRows(promptStable, SECTION_LABELS.hours),
    ...sectionRows(promptStable, SECTION_LABELS.contacts),
  ];
  const branchRowTexts = new Set(rows.map((r) => r.folded));
  return {
    names,
    rows,
    sharedAmounts: new Set(shared.flatMap((r) => amountsIn(r).map((a) => a.digits))),
    sharedUrls: new Set(shared.flatMap(linksIn)),
    sharedAddresses: shared.filter((r) => labelOf(r) === ADDRESS_LABEL).map((r) => fold(valueOf(r))),
    approved: [...new Set(approved.flatMap((a) => [a, ...a.split('\n')]).map((a) => fold(a).trim()))]
      // A branch row is never "approved text": masking it would hide exactly what this
      // module is looking for.
      .filter((a) => [...a].length >= 4 && !branchRowTexts.has(a))
      .sort((x, y) => y.length - x.length),
  };
}

function blank(text: string, part: string): string {
  if (part === '') return text;
  return text.split(part).join(' '.repeat(part.length));
}

function unique<T>(xs: readonly T[]): T[] {
  return [...new Set(xs)];
}

export type BranchHit = { at: number; branches: string[]; rows: BranchRow[]; what: string };

/** Every branch-specific fact in a reply, in the order the reply states them. */
export function branchFactsIn(reply: string, src: BranchFactSource): BranchHit[] {
  const all = src.names.length;
  const inOrder = (bs: readonly string[]) => src.names.filter((n) => bs.includes(n));
  const text = fold(reply);
  let masked = text;
  for (const a of src.approved) masked = blank(masked, a);

  const hits: BranchHit[] = [];

  // 1. Rows quoted whole, longest first. A row two branches print identically («Даваа:
  //    10:00 - 20:00») names both, and is then not branch-specific unless some branch lacks it.
  const byText = new Map<string, BranchRow[]>();
  for (const r of src.rows) if ([...r.folded].length >= 4) byText.set(r.folded, [...(byText.get(r.folded) ?? []), r]);
  for (const [folded, rows] of [...byText.entries()].sort((x, y) => y[0].length - x[0].length)) {
    const at = masked.indexOf(folded);
    if (at === -1) continue;
    const branches = inOrder(unique(rows.map((r) => r.branch)));
    masked = blank(masked, folded);
    if (branches.length === all) continue;
    hits.push({ at, branches, rows, what: rows[0]?.text ?? folded });
  }

  // 2. Links. Compared folded, because the text they are found in is folded; a short link's
  //    path differing only in case from another branch's is not a case worth a false miss.
  for (const link of linksIn(masked)) {
    if (src.sharedUrls.has(link)) continue;
    const owners = src.rows.filter((r) => r.urls.includes(link));
    const branches = inOrder(unique(owners.map((r) => r.branch)));
    if (owners.length === 0 || branches.length === all) continue;
    hits.push({ at: Math.max(0, masked.indexOf(link)), branches, rows: owners, what: link });
  }
  // A link's characters are never content (D-074).
  masked = blankUrls(masked);

  // 3. Amounts.
  for (const a of amountsIn(masked)) {
    if (src.sharedAmounts.has(a.digits)) continue;
    const owners = src.rows.filter((r) => r.amounts.includes(a.digits));
    const branches = inOrder(unique(owners.map((r) => r.branch)));
    if (owners.length === 0 || branches.length === all) continue;
    hits.push({ at: a.at, branches, rows: owners, what: a.digits });
  }

  // 4. A phone in the model's own format — «7600-1888», «7600 1888».
  for (const r of src.rows) {
    if (r.section !== 'contact') continue;
    for (const phone of r.amounts) {
      if (phone.length < 6 || src.sharedAmounts.has(phone)) continue;
      const m = new RegExp([...phone].join('[\\s\\-.() ]*'), 'u').exec(masked);
      if (m === null) continue;
      const owners = src.rows.filter((x) => x.section === 'contact' && x.amounts.includes(phone));
      const branches = inOrder(unique(owners.map((x) => x.branch)));
      if (branches.length === all) continue;
      hits.push({ at: m.index, branches, rows: owners, what: phone });
    }
  }

  // 5. Twelve code points of an address, outside any quotation of it.
  for (const r of src.rows) {
    if (r.address === null) continue;
    const cps = [...r.address];
    for (let i = 0; i + ADDRESS_OVERLAP_CP <= cps.length; i += 1) {
      const piece = cps.slice(i, i + ADDRESS_OVERLAP_CP).join('');
      if (src.sharedAddresses.some((s) => s.includes(piece))) continue;
      const at = masked.indexOf(piece);
      if (at === -1) continue;
      const owners = src.rows.filter((x) => x.address !== null && x.address.includes(piece));
      const branches = inOrder(unique(owners.map((x) => x.branch)));
      if (branches.length < all) hits.push({ at, branches, rows: owners, what: 'address' });
      break;
    }
  }

  return hits.sort((x, y) => x.at - y.at);
}

export type BranchVerdict =
  | { kind: 'pass'; stated: string[] }
  | { kind: 'ask'; stated: string[]; detail: string }
  | { kind: 'serve'; stated: string[]; body: string; detail: string }
  | { kind: 'handoff'; stated: string[]; detail: string };

/** The rows of `target` that say what `row` says about its own branch. Hours: the week. */
function counterparts(row: BranchRow, target: string, src: BranchFactSource): BranchRow[] {
  if (row.branch === target) return row.section === 'hours' ? src.rows.filter((r) => r.branch === target && r.section === 'hours') : [row];
  if (row.section === 'hours') return src.rows.filter((r) => r.branch === target && r.section === 'hours');
  return src.rows.filter((r) => r.branch === target && r.section === row.section && r.label === row.label);
}

export function judgeBranches(reply: string, src: BranchFactSource, established: Established): BranchVerdict {
  const hits = branchFactsIn(reply, src);
  const stated = src.names.filter((n) => hits.some((h) => h.branches.includes(n)));
  if (hits.length === 0) return { kind: 'pass', stated };

  const named = established.branches;
  const what = unique(hits.map((h) => `${h.what} → ${h.branches.join(' | ')}`)).join('; ');
  if (named.length === 0) {
    return { kind: 'ask', stated, detail: `the reply states branch facts and the customer named no branch: ${what}` };
  }
  const outside = hits.filter((h) => !h.branches.some((b) => named.includes(b)));
  if (outside.length === 0) return { kind: 'pass', stated };

  const target = named[0];
  if (established.from !== 'message' || named.length !== 1 || target === undefined) {
    return { kind: 'ask', stated, detail: `the reply states another branch's facts than the one named ${established.from === 'history' ? 'earlier' : 'here'} (${named.join(', ')}): ${what}` };
  }

  // The customer named this branch in this message: serve its own rows for every fact the
  // reply stated, in the order it stated them, each row once.
  const served: string[] = [];
  for (const h of hits) {
    const source = h.branches.includes(target) ? h.rows.filter((r) => r.branch === target) : h.rows;
    for (const r of source) {
      const found = counterparts(r, target, src);
      if (found.length === 0) {
        return { kind: 'handoff', stated, detail: `${target} has no row for «${r.label}», which the reply stated for ${r.branch}` };
      }
      for (const f of found) if (!served.includes(f.text)) served.push(f.text);
    }
  }
  return {
    kind: 'serve', stated, body: served.join('\n'),
    detail: `the customer named ${target}; the reply stated ${stated.filter((s) => s !== target).join(', ')}: ${what}`,
  };
}
