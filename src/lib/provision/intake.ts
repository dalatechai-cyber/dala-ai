/**
 * The intake document: one file per tenant, and the thing a human signs.
 *
 * ## Why a document and not a form that writes rows
 *
 * D-078 measured the gap this closes: `scripts/provision/` is nine hand-written Matrix SQL
 * files and no template, so client #3 does not fill in a config — somebody writes nine more
 * files. That is why Matrix took days.
 *
 * The questionnaire is how a client ANSWERS. It is not the machine input. Whatever it
 * arrives as — a form, a spreadsheet, a phone call written up — it is transcribed into one
 * canonical document, and THAT is what gets reviewed, diffed when the client changes their
 * mind, re-run after a correction, and read by whoever onboards client #4. A row that
 * appears with no document behind it cannot be reviewed; and the transcription is where a
 * human notices «the salon says this service does not exist».
 *
 * Same shape as `prompt/platform-mn-review.json`: a thing a person reads and signs, not a
 * thing a script infers.
 *
 * ## Two signatures, because two different people are responsible
 *
 * `confirmedBy` is the CLIENT's: prices, hours, the address. We cannot confirm these and
 * must not — the whole price guarantee rests on the tenant having SAID the number, and
 * `service_variants.confirmed_at` is where that lands (D-020).
 *
 * `sentences` carries no signature here AT ALL, deliberately. Every customer-visible
 * Mongolian string is the founder's to approve, and nothing in this pipeline may set
 * `reviewed_at`. The writer inserts them null; `gate/match.ts` refuses to build a prompt
 * containing an unreviewed line and `inbound/imageReply.ts` refuses to serve one. A
 * pipeline that could self-approve would defeat the one gate standing between a customer
 * and a sentence nobody read.
 */

/** `price_kind`, exactly as `service_variants` constrains it. */
export type IntakePriceKind = 'exact' | 'range' | 'from' | 'on_inspection' | 'none';

export type IntakeVariant = {
  variantKey: string;
  priceKind: IntakePriceKind;
  /** Digits only, as the client stated them. Null where the kind carries no number. */
  priceMin: string | null;
  priceMax: string | null;
  /** Required when `priceKind` is `none`: the bound refusal, so no number is anywhere. */
  refusalTopic: string | null;
};

export type IntakeService = {
  name: string;
  category: string | null;
  durationMinutes: number | null;
  /**
   * What customers call it, INCLUDING Latin spellings.
   *
   * Not derivable and therefore asked (D-067): `fold()` does not transliterate, so a
   * Cyrillic stem cannot match Latin text, and four of the mirror corpus's first eleven
   * turns were Latin. Store the shortest distinctive STEM rather than the full
   * romanisation — matching is token-prefix, so `emchilgee him` matches `himu` and
   * `himi` while the fully spelled `emchilgeenii himi` matches neither.
   */
  aliases: string[];
  variants: IntakeVariant[];
};

export type IntakeDocument = {
  slug: string;
  business: {
    displayName: string;
    vertical: string;
    timezone: string;
    locale: string;
    currencySymbol: string;
    currencySymbolBefore: boolean;
  };
  /** The CLIENT's signature over the facts. Null until they have actually confirmed them. */
  confirmedBy: { name: string; at: string } | null;
  hours: { weekday: number; opens: string | null; closes: string | null; closed: boolean }[];
  services: IntakeService[];
  contacts: { kind: string; value: string }[];
  booking: { url: string | null };
  /** `canned_responses` bodies by kind. Written with `reviewed_at` NULL, always. */
  sentences: Record<string, string>;
  /** What the bot must never say, and the sentence it says instead. */
  neverSay: { key: string; question: string; responseKind: string; stems: string[] }[];
  faqs: { question: string; answer: string }[];
  staff: { name: string; shortName: string | null }[];
};

export type ShapeProblem = { path: string; detail: string };

const PRICE_KINDS = new Set<string>(['exact', 'range', 'from', 'on_inspection', 'none']);
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Every key this reader understands. A key that is not here and does not begin with `_` is
 * reported rather than ignored, because the overwhelmingly likely cause is a misspelling of
 * one that IS here — and the failure mode is silent and dangerous. A client questionnaire
 * exported with `never_say` instead of `neverSay` parses perfectly, yields an empty rule
 * list, and the bot discusses the one topic the business said it must not. Refuse, do not
 * guess (D-057).
 *
 * `_`-prefixed keys are deliberate annotations — the shipped example carries its own
 * explanation that way — and are dropped rather than carried into the document.
 */
const KNOWN_KEYS = new Set([
  'slug', 'business', 'confirmedBy', 'hours', 'services', 'contacts', 'booking',
  'sentences', 'neverSay', 'faqs', 'staff',
]);

/**
 * Read an intake document, or say why it cannot be read.
 *
 * **Refuses rather than guesses**, which is D-057's rule stated for this file: a validator
 * that returns the part it managed reports a tenant as checked when most of it was never
 * examined. Every problem is collected — one run tells the operator everything to go back
 * to the client with, rather than one thing per round trip.
 */
export function readIntake(raw: unknown): { ok: true; doc: IntakeDocument } | { ok: false; problems: ShapeProblem[] } {
  const p: ShapeProblem[] = [];
  const bad = (path: string, detail: string) => p.push({ path, detail });

  if (!isRecord(raw)) return { ok: false, problems: [{ path: '', detail: 'the document is not an object' }] };

  for (const k of Object.keys(raw)) {
    if (KNOWN_KEYS.has(k) || k.startsWith('_')) continue;
    bad(k, `not a field this reader understands — did you mean one of ${[...KNOWN_KEYS].join(', ')}?`);
  }

  const slug = str(raw['slug']);
  // ascii-safe: a slug is a URL-ish identifier this platform assigns, never customer text.
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) bad('slug', 'must be lower-case words joined by hyphens');

  const biz = isRecord(raw['business']) ? raw['business'] : null;
  if (biz === null) bad('business', 'missing');
  else {
    for (const k of ['displayName', 'vertical', 'timezone', 'locale', 'currencySymbol'] as const) {
      if (str(biz[k]) === '') bad(`business.${k}`, 'missing or empty');
    }
    if (typeof biz['currencySymbolBefore'] !== 'boolean') bad('business.currencySymbolBefore', 'must be true or false');
  }

  const hoursRaw = Array.isArray(raw['hours']) ? raw['hours'] : null;
  if (hoursRaw === null) bad('hours', 'missing — use an empty array to say so explicitly');
  else {
    for (const [i, h] of hoursRaw.entries()) {
      if (!isRecord(h)) { bad(`hours[${i}]`, 'not an object'); continue; }
      const wd = h['weekday'];
      if (typeof wd !== 'number' || !Number.isInteger(wd) || wd < 0 || wd > 6) bad(`hours[${i}].weekday`, '0–6');
      if (typeof h['closed'] !== 'boolean') bad(`hours[${i}].closed`, 'must be true or false');
      if (h['closed'] !== true) {
        for (const k of ['opens', 'closes'] as const) {
          if (!CLOCK.test(str(h[k]))) bad(`hours[${i}].${k}`, 'HH:MM, or set closed: true');
        }
      }
    }
  }

  const servicesRaw = Array.isArray(raw['services']) ? raw['services'] : null;
  if (servicesRaw === null) bad('services', 'missing — use an empty array to say so explicitly');
  else {
    for (const [i, s] of servicesRaw.entries()) {
      if (!isRecord(s)) { bad(`services[${i}]`, 'not an object'); continue; }
      if (str(s['name']) === '') bad(`services[${i}].name`, 'missing');
      const vs = Array.isArray(s['variants']) ? s['variants'] : null;
      if (vs === null || vs.length === 0) { bad(`services[${i}].variants`, 'at least one, even if price_kind is none'); continue; }
      for (const [j, v] of vs.entries()) {
        if (!isRecord(v)) { bad(`services[${i}].variants[${j}]`, 'not an object'); continue; }
        const kind = str(v['priceKind']);
        const at = `services[${i}].variants[${j}]`;
        if (!PRICE_KINDS.has(kind)) { bad(`${at}.priceKind`, `one of ${[...PRICE_KINDS].join(', ')}`); continue; }
        const min = v['priceMin'] === null ? null : str(v['priceMin']);
        const max = v['priceMax'] === null ? null : str(v['priceMax']);
        // These mirror `service_variants`' own CHECK constraints, so a document that passes
        // here is not refused by the database three steps later.
        if (kind === 'exact' && (min === null || max !== null)) bad(at, 'exact: priceMin only');
        if (kind === 'range' && (min === null || max === null)) bad(at, 'range: priceMin and priceMax');
        if (kind === 'from' && (min === null || max !== null)) bad(at, 'from: priceMin only');
        if ((kind === 'on_inspection' || kind === 'none') && (min !== null || max !== null)) {
          bad(at, `${kind}: no numbers at all`);
        }
        if (kind === 'none' && str(v['refusalTopic']) === '') {
          bad(`${at}.refusalTopic`, 'required, so the service is named with no number anywhere');
        }
        for (const [k, val] of [['priceMin', min], ['priceMax', max]] as const) {
          // ascii-safe: a stated price is digits; formatting is the compiler's job.
          if (val !== null && !/^\d+$/.test(val)) bad(`${at}.${k}`, 'digits only, no separators or symbol');
        }
      }
    }
  }

  if (!isRecord(raw['sentences'])) bad('sentences', 'missing — an object of canned kind to Mongolian body');
  for (const k of ['contacts', 'neverSay', 'faqs', 'staff'] as const) {
    if (!Array.isArray(raw[k])) bad(k, 'missing — use an empty array to say so explicitly');
  }
  if (!isRecord(raw['booking'])) bad('booking', 'missing — use { "url": null } to say there is none');

  const cb = raw['confirmedBy'];
  if (cb !== null && !isRecord(cb)) bad('confirmedBy', 'null, or { name, at }');
  else if (isRecord(cb) && (str(cb['name']) === '' || str(cb['at']) === '')) {
    bad('confirmedBy', 'both name and at, or null');
  }

  if (p.length > 0) return { ok: false, problems: p };

  // BUILT, never cast. `raw as IntakeDocument` is "answer with what you managed" wearing a
  // type annotation: it hands the writer whatever else was in the file, unexamined, under a
  // name that says it was checked. Picking the fields explicitly means the document the
  // writer sees is exactly the document that was validated, and nothing more.
  const pick = <T>(v: unknown, f: (r: Record<string, unknown>) => T): T[] =>
    (Array.isArray(v) ? v : []).filter(isRecord).map(f);
  const b = raw['business'] as Record<string, unknown>;
  const cbr = raw['confirmedBy'];

  return { ok: true, doc: {
    slug,
    business: {
      displayName: str(b['displayName']), vertical: str(b['vertical']),
      timezone: str(b['timezone']), locale: str(b['locale']),
      currencySymbol: str(b['currencySymbol']),
      currencySymbolBefore: b['currencySymbolBefore'] === true,
    },
    confirmedBy: isRecord(cbr) ? { name: str(cbr['name']), at: str(cbr['at']) } : null,
    hours: pick(raw['hours'], (h) => ({
      weekday: Number(h['weekday']),
      opens: h['closed'] === true ? null : str(h['opens']),
      closes: h['closed'] === true ? null : str(h['closes']),
      closed: h['closed'] === true,
    })),
    services: pick(raw['services'], (sv) => ({
      name: str(sv['name']),
      category: typeof sv['category'] === 'string' ? sv['category'] : null,
      durationMinutes: typeof sv['durationMinutes'] === 'number' ? sv['durationMinutes'] : null,
      aliases: (Array.isArray(sv['aliases']) ? sv['aliases'] : []).filter((a): a is string => typeof a === 'string'),
      variants: pick(sv['variants'], (v) => ({
        variantKey: str(v['variantKey']),
        priceKind: str(v['priceKind']) as IntakePriceKind,
        priceMin: typeof v['priceMin'] === 'string' ? v['priceMin'] : null,
        priceMax: typeof v['priceMax'] === 'string' ? v['priceMax'] : null,
        refusalTopic: typeof v['refusalTopic'] === 'string' ? v['refusalTopic'] : null,
      })),
    })),
    contacts: pick(raw['contacts'], (c) => ({ kind: str(c['kind']), value: str(c['value']) })),
    booking: { url: typeof (raw['booking'] as Record<string, unknown>)['url'] === 'string'
      ? String((raw['booking'] as Record<string, unknown>)['url']) : null },
    sentences: Object.fromEntries(
      Object.entries(raw['sentences'] as Record<string, unknown>)
        .filter((e): e is [string, string] => typeof e[1] === 'string'),
    ),
    neverSay: pick(raw['neverSay'], (n) => ({
      key: str(n['key']), question: str(n['question']), responseKind: str(n['responseKind']),
      stems: (Array.isArray(n['stems']) ? n['stems'] : []).filter((x): x is string => typeof x === 'string'),
    })),
    faqs: pick(raw['faqs'], (f) => ({ question: str(f['question']), answer: str(f['answer']) })),
    staff: pick(raw['staff'], (st) => ({
      name: str(st['name']),
      shortName: typeof st['shortName'] === 'string' ? st['shortName'] : null,
    })),
  } };
}
