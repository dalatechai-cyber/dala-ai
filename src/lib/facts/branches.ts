/**
 * Branch tenants: one brand, one tenant per branch, each with its own Facebook Page
 * (founder, 2026-09-29; `docs/standards/dali.md` §7). Two rules follow, and this checks both
 * without a model:
 *
 *  - **Per-branch details stay with their branch.** A tenant's rows may not carry another
 *    branch's phone number, map link, address, staff name or branch name, and two branches may not hold
 *    the same phone, map link, address or staff member. The danger is copying: a branch
 *    onboarded from a sibling's rows would give the sibling's phone on its own Page, and no
 *    other guard would notice, because the allowed-number list is built from the tenant's
 *    own rows and the copied rows are among them.
 *  - **Shared facts stay the same.** Every branch carries the same price rows and the same
 *    booking link. A difference is a finding, named service by service.
 *
 * Which tenants are branches of one brand is configuration (`config/branch-groups.json`),
 * so nothing here names a tenant. Matching is by code point on NFC text (rule 6): no `\b`,
 * no `\w`, no locale. A phone number is compared as digits only, so «7711-2233»,
 * «7711 2233» and «+976 77112233» are one number.
 */
import { nfc } from '../mn/text.ts';
import { headPattern } from './consistency.ts';

export type BranchPrice = { service: string; variant: string; kind: string; min: number | null; max: number | null };
export type BranchStaff = { name: string; shortName: string | null };
/** Everything one branch tenant says or holds that the two rules above are about. */
export type BranchSide = {
  slug: string;
  contacts: readonly { kind: string; value: string }[];
  /** Active staff: the full name, and the short name customers call them by. */
  staff: readonly BranchStaff[];
  /** The branch's own label: the part of `tenants.display_name` after « — » («Brand — Branch»), or null. */
  branchName: string | null;
  /** Every text a customer or the model reads, with the row it came from («canned handoff»). */
  texts: readonly { source: string; text: string }[];
  prices: readonly BranchPrice[];
  bookingUrl: string | null;
};
export type BranchFinding = {
  /** `leak`: another branch's detail in this tenant's rows, or held by both. `drift`: a shared fact differs. */
  kind: 'leak' | 'drift';
  source: string;
  detail: string;
};

/**
 * Runs of digits, joined across up to three spaces (any kind, the no-break one included), dashes
 * (any kind: Word turns « - » into « – »), dots or brackets between digits: a phone's spacing.
 */
function digitRuns(text: string): string[] {
  return [...text.matchAll(/[0-9](?:[0-9]|[\p{Zs}\p{Pd}.()]{1,3}(?=[0-9]))*/gu)].map((m) => m[0].replace(/[^0-9]/gu, ''));
}

/**
 * The phone numbers in a contact value: six digits or more, with and without Mongolia's 976.
 * Numbers written one after another with only spaces between («7711 2233 9911 4455») join into
 * one run; a run of several whole 8-digit numbers is split back into them.
 */
export function phonesOf(value: string): string[] {
  const out = new Set<string>();
  for (const d of digitRuns(nfc(value))) {
    if (d.length < 6) continue;
    out.add(d);
    if (d.length === 11 && d.startsWith('976')) out.add(d.slice(3));
    if (d.length > 11 && d.length % 8 === 0) for (let i = 0; i < d.length; i += 8) out.add(d.slice(i, i + 8));
  }
  return [...out];
}

/**
 * A link as a comparable key: scheme, `www.`, trailing slashes and punctuation dropped; the host
 * lower-cased; the path kept exactly (a short link's id is case-sensitive). The query and
 * fragment are dropped too («?g_st=ic» from the Maps app's share button), except with
 * `query: true`, for a link whose query can matter (the booking link).
 */
export function linkKey(url: string, opts: { query?: boolean } = {}): string | null {
  const m = /^(?:https?:\/\/)?([^/\s?#]+)([^\s]*)$/iu.exec(url.trim().replace(/[.,;:!?)»"']+$/u, ''));
  if (m === null) return null;
  const host = (m[1] ?? '').toLowerCase().replace(/^www\./u, '');
  if (!host.includes('.')) return null;
  const rest = opts.query === true ? (m[2] ?? '') : (m[2] ?? '').replace(/[?#].*$/u, '');
  return `${host}${rest.replace(/\/+$/u, '')}`;
}

/** Every link in a text, with or without its scheme. */
function linksIn(text: string): string[] {
  // ascii-safe: host names are ASCII; a Cyrillic host is not a link any row here carries.
  const found = text.match(/(?:https?:\/\/)?(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\/[^\s<>«»"]*/gu) ?? [];
  return found.map(linkKey).filter((k): k is string => k !== null);
}

/** Lower-cased NFC with runs of spaces as one, for comparing addresses. */
function flat(s: string): string {
  return nfc(s).toLowerCase().replace(/\s+/gu, ' ').trim().replace(/[.,;:!?]+$/u, '');
}

/** Whether `needle` occurs in `hay` as whole words (no letter or digit on either side). */
function containsWhole(hay: string, needle: string): boolean {
  if (needle === '') return false;
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
    const before = at === 0 ? '' : (hay[at - 1] ?? '');
    const after = hay[at + needle.length] ?? '';
    if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return true;
  }
  return false;
}

/** The name a person is called by: the last word of three letters or more («Г. Мөнхзаяа» → «Мөнхзаяа»). */
export function staffKey(name: string): string | null {
  const words = nfc(name).split(/[\s.]+/u).filter((w) => [...w].length >= 3);
  const last = words[words.length - 1];
  return last === undefined ? null : last;
}

/** One person, compared whole, initials included: «Б. Сараа» and «Г. Сараа» are two people. */
function personKey(name: string): string {
  return nfc(name).toLowerCase().replace(/[\s.]+/gu, ' ').trim();
}

/** A name shorter than this is not searched for in texts: «Нар» would match every «та нар». */
const MIN_TEXT_NAME_CHARS = 4;

/** «Tara Salon — Парк Од» → «Парк Од»; a name with no « — » names no branch. */
export function branchLabel(displayName: string): string | null {
  const n = nfc(displayName);
  const at = n.lastIndexOf(' — ');
  const label = at < 0 ? '' : n.slice(at + 3).trim();
  return label === '' ? null : label;
}

type Details = {
  phones: Set<string>; links: Set<string>; addresses: Set<string>;
  /** Whole name → the row's name. */
  people: Map<string, string>;
  /** Every name a text might use (the last word of the name, the short name), lower-cased → the row's name. */
  called: Map<string, string>;
  branch: string | null;
};

function detailsOf(side: BranchSide): Details {
  const d: Details = {
    phones: new Set(), links: new Set(), addresses: new Set(), people: new Map(), called: new Map(),
    branch: side.branchName === null ? null : nfc(side.branchName),
  };
  for (const c of side.contacts) {
    if (c.kind === 'phone') for (const p of phonesOf(c.value)) d.phones.add(p);
    if (c.kind === 'maps_url') { const k = linkKey(c.value); if (k !== null) d.links.add(k); }
    if (c.kind === 'address' && flat(c.value) !== '') d.addresses.add(flat(c.value));
  }
  for (const s of side.staff) {
    if (personKey(s.name) !== '') d.people.set(personKey(s.name), s.name);
    for (const k of [staffKey(s.name), s.shortName === null ? null : nfc(s.shortName).trim()]) {
      if (k !== null && k !== '') d.called.set(k.toLowerCase(), s.name);
    }
  }
  return d;
}

/**
 * Another branch's details in this branch's rows (`leak`). `allowNames`: staff names that may
 * appear in every branch, from the group's configuration (a person who works at both, or a
 * name that is also an ordinary word the rows use). `allowAddresses`: another branch's address
 * the founder lets every branch give (D-170: Яармаг's Дали names Парк Од's address), matched
 * whole as the address row reads. `allowPhones`: the brand's shared lines, from
 * the same configuration, which every branch may hold and say; every other phone stays one
 * branch's own. `otherBranchIn`: when given, the other branch's NAME and its allowed ADDRESS may
 * appear only in texts from these sources (e.g. «KB «Салбарууд»», «fixed reply park_od_branch»);
 * anywhere else they are a leak as if never allowed, so a copy-pasted «this is the X branch's
 * page» in an FAQ is still caught. Staff names in `allowNames` are not narrowed.
 * `sayPhones`: another branch's own numbers that this branch may SAY, and only in the
 * `otherBranchIn` rows (founder, 2026-10-04: Tara has no shared line, so each branch's
 * «Салбарууд» gives the other branch's own numbers). Never held in a contact row, never said
 * anywhere else, and nothing at all without `otherBranchIn`.
 */
export function foreignDetails(
  own: BranchSide, sibling: BranchSide, allowNames: readonly string[] = [], allowPhones: readonly string[] = [],
  allowAddresses: readonly string[] = [], otherBranchIn: readonly string[] | null = null,
  sayPhones: readonly string[] = [],
): BranchFinding[] {
  const mine = detailsOf(own);
  const theirs = detailsOf(sibling);
  // Only what this branch SAYS: an address is never held by both branches, so this branch's own
  // address row equal to the allowed one is still a leak (unlike a shared phone line).
  const sayable = new Set(allowAddresses.map((a) => flat(a)));
  // With and without Mongolia's 976, as `phonesOf` reads a contact row.
  const shared = new Set(allowPhones.flatMap((p) => phonesOf(p)).flatMap((p) => (p.length === 8 ? [p, `976${p}`] : [p])));
  const sayablePhones = new Set(sayPhones.flatMap((p) => phonesOf(p)).flatMap((p) => (p.length === 8 ? [p, `976${p}`] : [p])));
  for (const p of shared) theirs.phones.delete(p);
  const allowed = new Set(allowNames.map((n) => staffKey(n)?.toLowerCase()).filter((k): k is string => k !== undefined));
  allowNames.forEach((n) => allowed.add(nfc(n).toLowerCase()));
  const out: BranchFinding[] = [];
  const leak = (source: string, detail: string) => out.push({ kind: 'leak', source, detail });

  // Held by both: this branch's own contact rows say the other branch's detail.
  for (const p of theirs.phones) if (mine.phones.has(p)) leak('contact_points phone', `is also ${sibling.slug}'s phone ${p}`);
  for (const l of theirs.links) if (mine.links.has(l)) leak('contact_points maps_url', `is also ${sibling.slug}'s map link ${l}`);
  for (const a of theirs.addresses) if (mine.addresses.has(a)) leak('contact_points address', `is also ${sibling.slug}'s address`);
  for (const [k, name] of theirs.people) {
    if (mine.people.has(k) && !allowed.has(k) && !allowed.has(staffKey(name)?.toLowerCase() ?? '')) {
      leak(`staff_members «${mine.people.get(k) ?? name}»`, `is also on ${sibling.slug}'s staff`);
    }
  }

  // Said in a text: only what is the other branch's alone (a detail held by both is found above).
  const phones = [...theirs.phones].filter((p) => !mine.phones.has(p));
  const links = [...theirs.links].filter((l) => !mine.links.has(l));
  const addresses = [...theirs.addresses].filter((a) => !mine.addresses.has(a) && !sayable.has(a));
  // The same without the founder's exemption, for a text outside `otherBranchIn`.
  const anyAddress = [...theirs.addresses].filter((a) => !mine.addresses.has(a));
  const scoped = otherBranchIn === null ? null : new Set(otherBranchIn.map((x) => nfc(x)));
  // A name this branch's own staff also answer to says nothing about which branch is meant.
  const names = [...theirs.called].filter(([k]) => !mine.called.has(k) && !allowed.has(k) && [...k].length >= MIN_TEXT_NAME_CHARS);
  const patterns = names.map(([k, name]) => ({ what: `staff member «${name}»${k === name.toLowerCase() ? '' : ` («${k}»)`}`, re: headPattern(k) }));
  // The other branch's name, unless it is also this branch's or allowed («Brand — Branch» is how
  // an operator names a branch; a copied «this Page is the X branch's» is the case it catches).
  const branch = theirs.branch;
  const otherBranch = branch !== null && branch.toLowerCase() !== mine.branch?.toLowerCase()
    ? { what: `branch name «${branch}»`, re: headPattern(branch), allowed: allowed.has(branch.toLowerCase()) }
    : null;
  if (otherBranch !== null && !otherBranch.allowed) patterns.push(otherBranch);
  for (const t of own.texts) {
    const text = nfc(t.text);
    // Outside the named sources, the other branch's name and address are not exempt.
    const exempt = scoped === null || scoped.has(nfc(t.source));
    // The other branch's own number only where the founder named the rows (never unscoped).
    const named = scoped !== null && scoped.has(nfc(t.source));
    const runs = digitRuns(text);
    for (const p of phones) {
      if (runs.some((r) => r.includes(p)) && !(named && sayablePhones.has(p))) leak(t.source, `carries ${sibling.slug}'s phone ${p}`);
    }
    const inText = new Set(linksIn(text));
    for (const l of links) if (inText.has(l)) leak(t.source, `carries ${sibling.slug}'s map link ${l}`);
    const lower = flat(text);
    for (const a of exempt ? addresses : anyAddress) if (containsWhole(lower, a)) leak(t.source, `carries ${sibling.slug}'s address «${a}»`);
    const low = text.toLowerCase();
    for (const { what, re } of patterns) if (re.test(low)) leak(t.source, `names ${sibling.slug}'s ${what}`);
    if (otherBranch !== null && otherBranch.allowed && !exempt && otherBranch.re.test(low)) {
      leak(t.source, `names ${sibling.slug}'s ${otherBranch.what} outside the rows allowed to (config/branch-groups.json other_branch_in)`);
    }
  }
  return out;
}

/** 350000 → «350,000», by hand: `toLocaleString` would depend on the runtime's locale. */
function money(n: number): string {
  return String(n).replace(/(?<=[0-9])(?=(?:[0-9]{3})+$)/gu, ',');
}

function priceText(p: BranchPrice): string {
  const n = (v: number | null) => (v === null ? '?' : `${money(v)}₮`);
  switch (p.kind) {
    case 'exact': return n(p.min);
    case 'range': return `${n(p.min)}–${n(p.max)}`;
    case 'from': return `from ${n(p.min)}`;
    case 'on_inspection': return 'on inspection';
    case 'none': return 'no price';
    default: return `${p.kind} ${n(p.min)}–${n(p.max)}`;
  }
}

const byCodePoint = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

/**
 * A shared fact that differs between two branches (`drift`): a price row or the booking link.
 *
 * `notOffered`: per slug, the price variants that branch does not offer at all (a level it has
 * no hairdresser for), from the group's configuration. That branch carries NO row for such a
 * variant, and its missing row is not drift; every price it does carry must still equal the
 * sibling's, so no price changes. A row it DOES carry for a variant it says it does not offer is
 * drift too: the configuration and the rows disagree, and the row would quote a level the branch
 * cannot serve.
 */
export type NotOffered = Readonly<Record<string, readonly { service: string | null; variant: string }[]>>;

export function sharedDrift(a: BranchSide, b: BranchSide, notOffered: NotOffered = {}): BranchFinding[] {
  const key = (p: BranchPrice) => `${nfc(p.service).trim()}\u0000${nfc(p.variant).trim()}`;
  const label = (k: string) => { const [s, v] = k.split('\u0000'); return v === '' ? `«${s}»` : `«${s}» (${v})`; };
  const index = (side: BranchSide) => new Map(side.prices.map((p) => [key(p), priceText(p)]));
  // A variant everywhere («1-р зэрэг»: a level the branch has no hairdresser for), or one
  // service's variant only (service named); `service: null` means every service.
  const omitted = (side: BranchSide) => {
    const list = (notOffered[side.slug] ?? []).filter((o) => nfc(o.variant).trim() !== '');
    return { has: (k: string) => { const [svc, v] = k.split('\u0000'); return list.some((o) => nfc(o.variant).trim() === v && (o.service === null || nfc(o.service).trim() === svc)); } };
  };
  const pa = index(a);
  const pb = index(b);
  const oa = omitted(a);
  const ob = omitted(b);
  const out: BranchFinding[] = [];
  for (const k of [...new Set([...pa.keys(), ...pb.keys()])].sort(byCodePoint)) {
    const x = pa.get(k);
    const y = pb.get(k);
    const variant = k.split('\u0000')[1] ?? '';
    const wrongRow = (side: BranchSide, has: string | undefined, omits: { has: (k: string) => boolean }) => {
      if (has !== undefined && omits.has(k)) {
        out.push({ kind: 'drift', source: `price ${label(k)}`, detail: `${side.slug} carries ${has} for «${variant}», which it does not offer (config/branch-groups.json not_offered)` });
      }
    };
    wrongRow(a, x, oa);
    wrongRow(b, y, ob);
    // The branch that does not offer the variant has no row for it: nothing to compare.
    if ((x === undefined && oa.has(k)) || (y === undefined && ob.has(k))) continue;
    if (x === y) continue;
    out.push({
      kind: 'drift', source: `price ${label(k)}`,
      detail: `${a.slug} ${x ?? 'has no such row'}, ${b.slug} ${y ?? 'has no such row'}`,
    });
  }
  const ua = a.bookingUrl === null ? null : linkKey(a.bookingUrl, { query: true }) ?? a.bookingUrl.trim();
  const ub = b.bookingUrl === null ? null : linkKey(b.bookingUrl, { query: true }) ?? b.bookingUrl.trim();
  if (ua !== ub) {
    out.push({ kind: 'drift', source: 'booking link', detail: `${a.slug} ${a.bookingUrl ?? '(none)'}, ${b.slug} ${b.bookingUrl ?? '(none)'}` });
  }
  return out;
}

/** One line per finding, for the onboarding and publish output. */
export function renderBranchFindings(slug: string, group: string, findings: readonly BranchFinding[]): string {
  if (findings.length === 0) return `branches: ${slug} (${group}): no other branch's details, and the shared facts agree.`;
  const leaks = findings.filter((f) => f.kind === 'leak');
  const drift = findings.filter((f) => f.kind === 'drift');
  return [
    `branches: ${slug} (${group}): ${leaks.length} row(s) with another branch's details, ${drift.length} shared fact(s) that differ`,
    ...leaks.map((f) => `  LEAK   ${f.source}: ${f.detail}`),
    ...drift.map((f) => `  DRIFT  ${f.source}: ${f.detail}`),
  ].join('\n');
}
