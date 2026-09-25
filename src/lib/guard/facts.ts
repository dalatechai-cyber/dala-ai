/**
 * Facts come from the data, never from the model's wording (D-120).
 *
 * Founder, 2026-09-24, first live day: *"Prices, address, phone numbers, hours and deposits
 * must always come from the data, never from the model's own wording."* The live instance
 * that made it concrete: «usnii himi» got «Усны хими 132,000₮–154,000₮ байна.» — two real
 * prices, under a service name that does not exist. `pricePresentation` saw the orphaned
 * price, found it had two owners («Усан хими» and «CMC тэжээл» both carry 132,000) and left
 * the reply as written, because guessing an owner had once served five unrelated services.
 *
 * ## The rule, as a property of the text
 *
 * Every FACT ROW — a line of the compiled prefix's price list, deposits, hours or contacts —
 * carries amounts. A model reply may contain those amounts only INSIDE text the platform
 * approved: a fact row quoted whole, a reviewed canned line, a published FAQ answer, a
 * deterministic reply, today's line from the volatile block, or a contact value on its own
 * (a phone number is the salon's phone number whichever sentence it sits in). Anything left
 * after those are masked out that is still one of a fact row's amounts is the model
 * restating a fact in its own words, and the reply is not sent.
 *
 * The address has no amount, so it is checked by overlap instead: twelve or more characters
 * of it outside a verbatim quote is a restatement. «Номин Хайпермаркетын баруун талд» without
 * «Яармагийн» sends a customer to the wrong hypermarket, and it is the model's wording.
 *
 * ## What is served instead
 *
 * The rows themselves, in the order the reply mentioned them — the fact rows it quoted, the
 * fact rows whose amounts it restated, and any reviewed line it quoted whole. Nothing is
 * reworded and nothing is edited: `gate/pinned.ts`'s move, one table over. An amount two
 * rows share is narrowed by the other amount beside it («132,000₮–154,000₮» is one row's
 * range, not two rows' prices) and then by the name the reply wrote; what is still shared
 * is served whole, because every row it could mean is true.
 *
 * The cost is stated rather than discovered (D-077): the rest of the reply goes. A
 * paragraph about why a perm suits thin hair, ending in a restated price, becomes the price
 * row. That is the founder's trade — a customer acts on a number.
 */
import { fold, nfc } from '../mn/text.ts';
import { blankUrls } from '../mn/extract.ts';
import { sectionRows } from '../quality/serviceNames.ts';
import { CONTACT_KIND_LABELS, WEEKDAYS } from '../prompt/tenant.ts';
import { containsStem } from '../mn/match.ts';

export type FactSection = 'price' | 'deposit' | 'hours' | 'contact';

/**
 * `group` is the heading the row was read under — `''` for the tenant-wide sections, a
 * branch's own heading otherwise (D-125). It exists for one rule: hours are one fact, the
 * WEEK, and a week is one heading's rows, never two branches' weeks served as one.
 */
export type FactRow = { section: FactSection; text: string; amounts: string[]; group: string };

export type FactSource = {
  rows: FactRow[];
  /** Approved text the reply may carry whole, folded. Longest first. */
  verbatim: string[];
  /** Values safe on their own, folded: contact values and their comma-separated parts. */
  standalone: string[];
  /** Address values, folded. */
  addresses: string[];
  /** The approved texts as written, so one the reply quoted whole is served beside the rows. */
  quotable: string[];
  /**
   * `service_aliases` as whole words per folded service NAME (the row's name part, variant
   * removed). A price row is corroborated by one of its service's aliases as well as by its
   * name: «eho yamar unetei ve» names Эхо by its alias, and the model's «Эхогийн» cannot
   * match a three-letter name any other way — so Эхо's correct prices were refused as
   * «whose?» (DalaTech's test set, 2026-09-26, q04). Whole words only, as short names are.
   */
  aliases?: Readonly<Record<string, readonly string[]>>;
  /**
   * Which weekday is today and tomorrow on the tenant's clock, and the tenant's own
   * sentence for tomorrow's hours if it has one (D-126). Absent: hours are served as the
   * whole week, as before.
   */
  days?: DayFocus;
};

export type DayFocus = {
  today: number; tomorrow: number; tomorrowLine: string | null;
  /** Of today and tomorrow, the weekdays a `tenant_closures` range covers: never narrowed to. */
  closed?: readonly number[];
};

/**
 * The one day a reply is about, or null. The MODEL's words are read, and the model writes
 * Cyrillic: «маргааш» is tomorrow and «өнөөдөр» today, by token prefix so «маргаашийн» and
 * «өнөөдрийн» count; otherwise exactly one weekday name. Two of anything is a week.
 */
function focusDay(folded: string, days: DayFocus): { dow: number; tomorrow: boolean } | null {
  const tomorrow = containsStem(folded, 'маргааш');
  const today = containsStem(folded, 'өнөөд');
  if (tomorrow && today) return null;
  if (tomorrow) return { dow: days.tomorrow, tomorrow: true };
  if (today) return { dow: days.today, tomorrow: false };
  const named = WEEKDAYS.filter((w) => containsStem(folded, fold(w.label)));
  return named.length === 1 ? { dow: named[0]!.dow, tomorrow: named[0]!.dow === days.tomorrow } : null;
}

/** The day, unless a closure covers it: its regular hours would then be the false answer. */
function openFocus(folded: string, days: DayFocus): { dow: number; tomorrow: boolean } | null {
  const f = focusDay(folded, days);
  return f === null || (days.closed ?? []).includes(f.dow) ? null : f;
}

/** The hours row for one weekday: the row the hours section prints under that day's name. */
function dayRow(rows: readonly FactRow[], dow: number): FactRow | null {
  const label = WEEKDAYS.find((w) => w.dow === dow)?.label;
  if (label === undefined) return null;
  const found = rows.filter((r) => r.section === 'hours' && fold(r.text).startsWith(`${fold(label)}:`));
  return found.length === 1 ? found[0]! : null;
}

/** Twelve code points of an address outside a verbatim quote is a restatement of it. */
export const ADDRESS_OVERLAP_CP = 12;

/**
 * The amounts in a text: digit runs reduced to digits, kept when they have four or more
 * digits or are a clock time. «1-р», «3-5 удаа» and «30 хувь» are not facts this guards.
 * «430 мянга» is 430000, «10 цаг» is 1000, and «430 000» (a space as thousands separator)
 * is one amount, not two.
 */
export function amountsIn(text: string): { digits: string; at: number; end: number }[] {
  const t = nfc(text).replace(/(\p{Nd}) (?=\p{Nd}{3}(?!\p{Nd}))/gu, '$1 ');
  const out: { digits: string; at: number; end: number }[] = [];
  for (const m of t.matchAll(/\p{Nd}(?:[\p{Nd},.:  ]*\p{Nd})?/gu)) {
    const raw = m[0];
    const at = m.index ?? 0;
    let digits = raw.replace(/\P{Nd}/gu, '');
    const after = fold(t.slice(at + raw.length, at + raw.length + 8)).trimStart();
    if (after.startsWith('мянга')) digits = `${digits}000`;
    else if (digits.length <= 2 && !raw.includes(':') && after.startsWith('цаг')) digits = `${digits.padStart(2, '0')}00`;
    if (digits.length >= 4 || raw.includes(':')) out.push({ digits, at, end: at + raw.length });
  }
  return out;
}

/** Are `a` and `b` the two ends of one written range: only currency, space and a dash between? */
function isRangeOf(text: string, a: { at: number; end: number }, b: { at: number; end: number }): boolean {
  const [first, second] = a.at < b.at ? [a, b] : [b, a];
  if (first.end > second.at) return false;
  return /^[\s\u00a0₮]*[-–—][\s\u00a0₮]*$/u.test(text.slice(first.end, second.at));
}

function valueOf(row: string): string {
  const colon = row.indexOf(': ');
  return colon === -1 ? '' : row.slice(colon + 2).trim();
}

/**
 * Everything the check needs, from the compiled prefix and the approved text beside it.
 * Cheap enough to build per request: four section scans and some string folding.
 */
export function factSourceFrom(
  promptStable: string,
  labels: { priceList: string; deposits: string; hours: string; contacts: string },
  approved: readonly string[],
  /**
   * More sections to read facts from: each branch's own contacts, hours and prices when the
   * tenant has two or more branches (`branches/facts.ts`). Empty for every other tenant, and
   * then this function is what it was — so a branch fact restated in the model's words is
   * served from its row exactly as a tenant-wide one is. WHICH branch it belongs to is a
   * separate question, judged after this one (`judgeBranches`).
   */
  extra: readonly { section: FactSection; label: string }[] = [],
): FactSource {
  const rows: FactRow[] = [];
  const add = (section: FactSection, label: string, group: string): string[] => {
    const found = sectionRows(promptStable, label);
    for (const text of found) rows.push({ section, text, amounts: amountsIn(text).map((a) => a.digits), group });
    return found;
  };
  add('price', labels.priceList, '');
  add('deposit', labels.deposits, '');
  add('hours', labels.hours, '');
  const contacts = add('contact', labels.contacts, '');
  for (const x of extra) {
    const found = add(x.section, x.label, x.label);
    if (x.section === 'contact') contacts.push(...found);
  }

  const addressPrefix = `${CONTACT_KIND_LABELS['address'] ?? ''}: `;
  const addresses = contacts.filter((c) => c.startsWith(addressPrefix)).map((c) => fold(valueOf(c))).filter((a) => a !== '');
  const standalone = contacts.flatMap((c) => {
    const v = valueOf(c);
    return [v, ...v.split(',').map((p) => p.trim())];
  }).map(fold).filter((v) => [...v].length >= 4);

  // An approved text is quoted whole or line by line: a FAQ answer is often a list.
  const verbatim = [...new Set([
    ...rows.map((r) => r.text),
    ...approved.flatMap((a) => [a, ...a.split('\n')]),
  ].map((v) => fold(v).trim()).filter((v) => [...v].length >= 4))]
    .sort((a, b) => b.length - a.length);
  return {
    rows, verbatim, addresses,
    standalone: [...new Set(standalone)].sort((a, b) => b.length - a.length),
    quotable: approved.map((a) => a.trim()).filter((a) => [...a].length >= 4),
  };
}

function wordsOf(text: string): string[] {
  return fold(text).split(/[^\p{L}\p{N}]+/u).filter((w) => w !== '');
}

function blank(text: string, part: string): string {
  if (part === '') return text;
  return text.split(part).join(' '.repeat(part.length));
}

export type FactCheck =
  | { restated: false }
  | { restated: true; detail: string; served: string | null };

/**
 * Did the reply restate a fact in its own words? If so, the rows it should have quoted.
 *
 * `served` is null when a restated price cannot be shown to belong to any row — no range
 * partner and no word of any owner's name in the reply or the question. The caller serves
 * the handoff line then: the model's wording is never sent, and neither is a guess.
 */
/** A price row's service-name words — what corroborates it. */
/** The folded service name of a price row: its name part, variant parenthetical removed. */
export function rowName(row: string): string {
  return fold(row.slice(0, Math.max(0, row.indexOf(':')))).replace(/\s*\([^()]*\)\s*$/u, '').trim();
}

function nameWords(row: string): string[] {
  const name = fold(row.slice(0, Math.max(0, row.indexOf(':')))).replace(/\s*\([^()]*\)\s*$/u, '');
  return name.split(/[^\p{L}\p{N}]+/u).filter((w) => w !== '');
}

/** The words of a price row's variant parenthetical: «(Сарын төлбөр)» → сарын, төлбөр. */
function variantWords(row: string): string[] {
  const m = /\(([^()]*)\)\s*$/u.exec(fold(row.slice(0, Math.max(0, row.indexOf(':')))));
  return m === null ? [] : (m[1] ?? '').split(/[^\p{L}\p{N}]+/u).filter((w) => w !== '');
}

/** The clause holding [at, end): out to the nearest line or sentence break, or a comma
 * that is not a thousands separator. */
function clauseAround(text: string, at: number, end: number): string {
  const isBreak = (i: number): boolean => {
    const c = text[i] ?? '';
    if (c === '\n' || c === ';' || c === '!' || c === '?') return true;
    return (c === '.' || c === ',') && !/\p{Nd}/u.test(text[i + 1] ?? '');
  };
  let from = at;
  while (from > 0 && !isBreak(from - 1)) from -= 1;
  let to = end;
  while (to < text.length && !isBreak(to)) to += 1;
  return text.slice(from, to);
}

/**
 * Words share a stem when their first four code points agree: «будаг», «будалт» and
 * «будахад» are one word to a customer. The same floor the gate puts on a stem.
 */
export const CORROBORATE_CP = 4;

function stemOf(word: string): string {
  return [...word].slice(0, CORROBORATE_CP).join('');
}

export function checkFacts(reply: string, source: FactSource, customerMessage = ''): FactCheck {
  // Approved text first — the booking line and the contact rows carry links — then every
  // link left, which `urlsNotAllowed` judges and whose characters are never content (D-074).
  // Everything is blanked to its own length, so a position in `masked` is one in `text`.
  const text = fold(reply);
  let masked = text;
  for (const v of source.verbatim) masked = blank(masked, v);
  for (const v of source.standalone) masked = blank(masked, v);
  masked = blankUrls(masked);
  let nameText = text;
  for (const q of source.quotable) {
    for (const line of [q, ...q.split('\n')]) {
      const f = fold(line).trim();
      if ([...f].length >= 4) nameText = blank(nameText, f);
    }
  }

  type Hit = { at: number; rows: FactRow[]; what: string };
  const hits: Hit[] = [];

  const amounts = amountsIn(masked);
  for (const a of amounts) {
    let owners = source.rows.filter((r) => r.amounts.includes(a.digits));
    if (owners.length === 0) continue;
    let narrowedByPartner = false;
    if (owners.length > 1) {
      // The other end of a RANGE: a range names one row, not two. Only an amount written as
      // the other end of «A–B» counts. Two prices on one line are not a range: «CICA … 198,000₮
      // (курсээр 154,000₮)» is two rows of one service, and reading it as a range served
      // «Хуримын засалт: 154,000₮–198,000₮» — the one row holding both numbers — to a CICA
      // question (the 2026-09-25 bake-off, both models). It then skipped the name check below.
      const partners = amounts.filter((b) => b !== a && isRangeOf(masked, a, b)).map((b) => b.digits);
      const byPartner = owners.filter((r) => partners.some((p) => r.amounts.includes(p)));
      if (byPartner.length > 0) { owners = byPartner; narrowedByPartner = true; }
    }
    if (owners.length > 1) {
      const byName = owners.filter((r) => {
        const name = fold(r.text.slice(0, Math.max(0, r.text.indexOf(':')))).replace(/\s*\([^()]*\)\s*$/u, '').trim();
        return name !== '' && text.includes(name);
      });
      if (byName.length > 0) owners = byName;
    }
    // Hours are one fact, the week: «10:00-20:00 every day» is answered with every day,
    // including the one that differs. The week of each heading an owner came from — with
    // one location that is the one tenant-wide week, exactly as before.
    if (owners.some((r) => r.section === 'hours')) {
      const weeks = new Set(owners.filter((r) => r.section === 'hours').map((r) => r.group));
      owners = source.rows.filter((r) => r.section === 'hours' && weeks.has(r.group));
      // …unless the reply is about ONE day and this amount is that day's (founder,
      // 2026-09-25: «Hi margaash tanaih ajilahu» got all seven days). Then that day's row,
      // or the tenant's own tomorrow sentence. One location only: a branch week is judged
      // by `judgeBranches`. An amount that is not the named day's — «маргааш» over Sunday's
      // hours — keeps the week, which is true whatever the model meant.
      const focus = source.days === undefined || weeks.size !== 1 || !weeks.has('') ? null : openFocus(text, source.days);
      const row = focus === null ? null : dayRow(owners, focus.dow);
      if (focus !== null && row !== null && row.amounts.includes(a.digits)) {
        const line = focus.tomorrow ? source.days?.tomorrowLine ?? null : null;
        owners = [line === null ? row : { ...row, text: line }];
      }
    }
    // A PRICE row must be corroborated — its range partner, or a word of its service's name
    // in the reply or the question. Measured on Matrix's corpus: «Маникюр хэд вэ?» answered
    // from a superseded nail list carried 50,000, which today only «Хэлбэржүүлэлт (Мастер)»
    // has; serving a haircut price to a manicure question is worse than the handoff. So an
    // uncorroborated price is refused rather than guessed (`pricePresentation`'s lesson).
    //
    // A name word of four or more code points matches by stem («будаг» ~ «будалтын»); a
    // shorter one («Сор») only whole. Among owners, the ones with the most name words
    // present win: «Хими арчилт хэд вэ?» names both of its words and only one of «Усан хими».
    //
    // The reply's words are read with its quoted approved LINES blanked: a line the tenant
    // wrote is not the model saying whose price this is. DalaTech's coming-soon line names
    // Вира, Эхо, Нова and Ора in one sentence, and a reply that carried it corroborated
    // every one of them — «Эхо минутаар хэдээр…» was served Ора's 250,000₮ beside Эхо's, and
    // «Дали, Вира хоёр…» nine rows (the test set, 2026-09-26, q05 and x03).
    const seen = [...wordsOf(nameText), ...wordsOf(customerMessage)];
    const stems = new Set(seen.filter((w) => [...w].length >= CORROBORATE_CP).map(stemOf));
    const whole = new Set(seen);
    const hit = (w: string): boolean => ([...w].length >= CORROBORATE_CP ? stems.has(stemOf(w)) : whole.has(w));
    const score = (r: FactRow): number => nameWords(r.text).filter(hit).length
      + (source.aliases?.[rowName(r.text)] ?? []).filter((a) => whole.has(a)).length;
    const priced = owners.filter((r) => r.section === 'price');
    const best = Math.max(0, ...priced.map(score));
    let corroborated = narrowedByPartner ? priced : priced.filter((r) => best > 0 && score(r) === best);
    // One service's rows tied on its name are told apart by the variant the reply wrote:
    // «Вира сарын төлбөр 150,000₮» is the monthly row, not the setup row that shares the
    // amount. Nothing written about a variant keeps them all, as before.
    // Read in the amount's own clause only: a list that writes both variants on two lines
    // must not have both amounts drawn to whichever variant has more words.
    if (corroborated.length > 1) {
      const clause = wordsOf(clauseAround(nameText, a.at, a.end));
      const near = new Set(clause.filter((w) => [...w].length >= CORROBORATE_CP).map(stemOf));
      const variant = (r: FactRow): number => variantWords(r.text)
        .filter((w) => ([...w].length >= CORROBORATE_CP ? near.has(stemOf(w)) : clause.includes(w))).length;
      const top = Math.max(...corroborated.map(variant));
      if (top > 0) corroborated = corroborated.filter((r) => variant(r) === top);
    }
    if (priced.length > 0 && corroborated.length === 0) {
      hits.push({ at: a.at, rows: [], what: `${a.digits} (whose?)` });
      continue;
    }
    if (priced.length > 0) owners = [...owners.filter((r) => r.section !== 'price'), ...corroborated];
    hits.push({ at: a.at, rows: owners, what: a.digits });
  }

  // A phone number rewritten with separators — «7600-1888», «7600 1888» — is the number in
  // the model's own format. The digits are compared with the separators between them gone.
  for (const r of source.rows) {
    if (r.section !== 'contact') continue;
    for (const phone of r.amounts) {
      if (phone.length < 6) continue;
      const m = new RegExp([...phone].join('[\\s\\-.()\u00A0]*'), 'u').exec(masked);
      if (m !== null) hits.push({ at: m.index, rows: [r], what: phone });
    }
  }

  for (const address of source.addresses) {
    const cps = [...address];
    for (let i = 0; i + ADDRESS_OVERLAP_CP <= cps.length; i += 1) {
      const piece = cps.slice(i, i + ADDRESS_OVERLAP_CP).join('');
      const at = masked.indexOf(piece);
      if (at === -1) continue;
      const row = source.rows.find((r) => r.section === 'contact' && fold(valueOf(r.text)) === address);
      if (row !== undefined) hits.push({ at, rows: [row], what: 'address' });
      break;
    }
  }

  if (hits.length === 0) return { restated: false };

  // What the reply quoted whole — fact rows and approved lines — keeps its place beside the
  // restated rows: a booking answer keeps its booking line.
  const quoted: { at: number; text: string }[] = [];
  for (const r of source.rows) {
    const at = text.indexOf(fold(r.text));
    if (at !== -1) quoted.push({ at, text: r.text });
  }
  for (const q of source.quotable) {
    const at = text.indexOf(fold(q));
    if (at !== -1) quoted.push({ at, text: q });
  }
  const ordered = [
    ...hits.flatMap((h) => h.rows.map((r) => ({ at: h.at, text: r.text }))),
    ...quoted,
  ].sort((x, y) => x.at - y.at);
  // An amount nobody can be shown to own is not served as somebody's price: the whole
  // answer is refused and the caller serves the handoff line.
  if (hits.some((h) => h.rows.length === 0)) {
    return { restated: true, detail: `restated in the model's words: ${[...new Set(hits.map((h) => h.what))].join(', ')}`, served: null };
  }
  const served: string[] = [];
  for (const o of ordered) {
    // A quoted approved line that contains a row already served (or is contained by one) is
    // one fact, not two.
    const f = fold(o.text);
    if (served.some((s) => fold(s).includes(f) || f.includes(fold(s)))) continue;
    served.push(o.text);
  }
  const restated = [...new Set(hits.map((h) => h.what))];
  return {
    restated: true,
    detail: `restated in the model's words: ${restated.join(', ')}`,
    served: served.length === 0 ? null : served.join('\n'),
  };
}
