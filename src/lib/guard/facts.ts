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
import { CONTACT_KIND_LABELS } from '../prompt/tenant.ts';

export type FactSection = 'price' | 'deposit' | 'hours' | 'contact';

export type FactRow = { section: FactSection; text: string; amounts: string[] };

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
};

/** Twelve code points of an address outside a verbatim quote is a restatement of it. */
export const ADDRESS_OVERLAP_CP = 12;

/**
 * The amounts in a text: digit runs reduced to digits, kept when they have four or more
 * digits or are a clock time. «1-р», «3-5 удаа» and «30 хувь» are not facts this guards.
 * «430 мянга» is 430000, «10 цаг» is 1000, and «430 000» (a space as thousands separator)
 * is one amount, not two.
 */
export function amountsIn(text: string): { digits: string; at: number }[] {
  const t = nfc(text).replace(/(\p{Nd}) (?=\p{Nd}{3}(?!\p{Nd}))/gu, '$1 ');
  const out: { digits: string; at: number }[] = [];
  for (const m of t.matchAll(/\p{Nd}(?:[\p{Nd},.:  ]*\p{Nd})?/gu)) {
    const raw = m[0];
    const at = m.index ?? 0;
    let digits = raw.replace(/\P{Nd}/gu, '');
    const after = fold(t.slice(at + raw.length, at + raw.length + 8)).trimStart();
    if (after.startsWith('мянга')) digits = `${digits}000`;
    else if (digits.length <= 2 && !raw.includes(':') && after.startsWith('цаг')) digits = `${digits.padStart(2, '0')}00`;
    if (digits.length >= 4 || raw.includes(':')) out.push({ digits, at });
  }
  return out;
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
): FactSource {
  const rows: FactRow[] = [];
  const add = (section: FactSection, label: string): string[] => {
    const found = sectionRows(promptStable, label);
    for (const text of found) rows.push({ section, text, amounts: amountsIn(text).map((a) => a.digits) });
    return found;
  };
  add('price', labels.priceList);
  add('deposit', labels.deposits);
  add('hours', labels.hours);
  const contacts = add('contact', labels.contacts);

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
function nameWords(row: string): string[] {
  const name = fold(row.slice(0, Math.max(0, row.indexOf(':')))).replace(/\s*\([^()]*\)\s*$/u, '');
  return name.split(/[^\p{L}\p{N}]+/u).filter((w) => w !== '');
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

  type Hit = { at: number; rows: FactRow[]; what: string };
  const hits: Hit[] = [];

  const amounts = amountsIn(masked);
  for (const a of amounts) {
    let owners = source.rows.filter((r) => r.amounts.includes(a.digits));
    if (owners.length === 0) continue;
    let narrowedByPartner = false;
    if (owners.length > 1) {
      // The other amounts on the same line: a range names one row, not two.
      const lineStart = masked.lastIndexOf('\n', a.at) + 1;
      const lineEnd = masked.indexOf('\n', a.at) === -1 ? masked.length : masked.indexOf('\n', a.at);
      const partners = amounts.filter((b) => b.at >= lineStart && b.at < lineEnd && b !== a).map((b) => b.digits);
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
    // including the one that differs.
    if (owners.some((r) => r.section === 'hours')) owners = source.rows.filter((r) => r.section === 'hours');
    // A PRICE row must be corroborated — its range partner, or a word of its service's name
    // in the reply or the question. Measured on Matrix's corpus: «Маникюр хэд вэ?» answered
    // from a superseded nail list carried 50,000, which today only «Хэлбэржүүлэлт (Мастер)»
    // has; serving a haircut price to a manicure question is worse than the handoff. So an
    // uncorroborated price is refused rather than guessed (`pricePresentation`'s lesson).
    //
    // A name word of four or more code points matches by stem («будаг» ~ «будалтын»); a
    // shorter one («Сор») only whole. Among owners, the ones with the most name words
    // present win: «Хими арчилт хэд вэ?» names both of its words and only one of «Усан хими».
    const seen = [...wordsOf(text), ...wordsOf(customerMessage)];
    const stems = new Set(seen.filter((w) => [...w].length >= CORROBORATE_CP).map(stemOf));
    const whole = new Set(seen);
    const score = (r: FactRow): number => nameWords(r.text)
      .filter((w) => ([...w].length >= CORROBORATE_CP ? stems.has(stemOf(w)) : whole.has(w))).length;
    const priced = owners.filter((r) => r.section === 'price');
    const best = Math.max(0, ...priced.map(score));
    const corroborated = narrowedByPartner ? priced : priced.filter((r) => best > 0 && score(r) === best);
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
