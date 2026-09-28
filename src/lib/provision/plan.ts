/**
 * From a filled questionnaire to everything the onboarding command writes.
 *
 * `questionnaire.ts` says what the client answered. This file decides what each answer
 * becomes — a row, a knowledge document, a sentence drafted for the founder to sign, or an
 * entry on the MISSING list — and it is the only place that decides.
 *
 * ## Three kinds of words, kept apart all the way to the database
 *
 *  1. **The client's own words** — service names, prices, the address, FAQ answers, the
 *     deposit and cancellation rules. Written as the client wrote them (NFC, tidied), never
 *     rephrased. They reach a customer only after the CLIENT confirms the summary: prices
 *     land with `confirmed_at` null and FAQs as `seeded`, and the compiler leaves both out
 *     until `approve.ts` records the client's confirmation (D-020, D-079).
 *  2. **Our words, drafted** — the canned sentences, filled from
 *     `scripts/provision/templates/onboarding.mn.json`. Written with `reviewed_at` null;
 *     the reply path refuses an unreviewed line, so none is sent until the founder signs
 *     this tenant's wording sheet.
 *  3. **Nothing else.** A question the client left blank is NOT filled in from a default,
 *     a neighbouring answer or another tenant. It goes on `missing`, which the readiness
 *     record puts in the daily report until somebody answers it.
 *
 * ## What is deliberately not inferred
 *
 * Latin spellings of service names (D-067: rows, not a transliterator), the Page id Meta
 * routes by (the form asks for the Page's NAME), a staff member's status when the column is
 * blank, a price that does not parse. Each is asked, never guessed.
 */
import { nfc } from '../mn/text.ts';
import type { IntakeDocument, IntakeService, IntakeVariant } from './intake.ts';
import {
  isClosedWord, parseClock, parseDuration, parsePriceCell, ticked, WEEKDAYS, yesNo,
  type Choice, type FormAnswers, type ParsedPrice,
} from './questionnaire.ts';

export type Templates = {
  sentences: Record<string, Record<string, unknown>>;
  client_summary: Record<string, unknown>;
  model_visible: {
    rule_question: string;
    deposit_label: string;
    kb_titles: Record<string, string>;
  };
  verticals: Record<string, unknown>;
};

export type Missing = {
  /** The questionnaire's own number, so the operator can point the client at it. */
  question: string;
  what: string;
  /** A wrong or absent answer could reach a customer while this is open (D-079's test). */
  holdsReady: boolean;
  /** Who can answer it: the client (goes on their summary) or the operator (an id, a flag). */
  audience: 'client' | 'operator';
  /** The thing it is about, in the client's own words (a service name), for the summary. */
  subject?: string;
  /** What is asked, as a key into the summary's `asks` wording. */
  code?: string;
};

export type WordingLine = {
  kind: string;
  body: string;
  template: string;
  derivedFrom: string;
  /** Byte-identical to a line the founder already approved for a live tenant. */
  alreadyApprovedBytes: boolean;
  /** The date the founder approved the TEMPLATE this line was filled from, if they have. */
  templateApproved: string | null;
};

export type StaffRow = {
  name: string; shortName: string | null; tier: string | null;
  active: boolean; customerSelectable: boolean; affectsPrice: boolean;
};

export type ChannelPlan = {
  provider: 'facebook_page' | 'instagram';
  externalId: string | null;
  label: string;
};

export type OnboardPlan = {
  intake: IntakeDocument;
  staff: StaffRow[];
  deposits: { appliesTo: string; ruleText: string }[];
  documents: { key: string; title: string; body: string }[];
  channels: ChannelPlan[];
  replyStyle: { max_emoji: number } | null;
  wording: WordingLine[];
  /** Mongolian the model reads and no customer is sent (rule questions, document titles). */
  modelVisible: { where: string; text: string }[];
  missing: Missing[];
  /** Steps a person does by hand, in order, with why. */
  manual: string[];
  /** Answers recorded for the operator that no row carries (tone, sample replies). */
  notes: string[];
  vertical: { value: string; reason: string };
  signer: FormAnswers['signer'];
  /** The branch this Page belongs to and how many there are, as the client wrote it. */
  branch: { count: string; thisPage: string };
  commentsRequested: boolean;
};

export type PlanOptions = {
  slug: string;
  templates: Templates;
  /** Overrides the vertical read from 1.2. */
  vertical?: string;
  /** The numeric Page id. The form asks for the Page's name; Meta routes by id. */
  facebookPageId?: string;
  /** The Instagram account id, when the operator has it. */
  instagramId?: string;
};

const tidy = (s: string): string => nfc(s).replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').trim();
const lower = (s: string): string => s.toLocaleLowerCase('mn');
const EMOJI = /\p{Extended_Pictographic}️?/gu;
const URL = /https?:\/\/[^\s<>«»"]+/giu;
const MAPS = /^https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps|(?:www\.)?google\.[^/]+\/maps|maps\.google\.)/iu;

/** Split a client's list answer («гомдол, буцаалт; хүүхдийн үнэ») into its items. */
export function listItems(s: string): string[] {
  return tidy(s).split(/[\n,;]+/u).map((x) => x.replace(/^[-–•*·\d.)\s]+/u, '').replace(/[.!?]+$/u, '').trim())
    .filter((x) => x !== '');
}

/** An answer that says there is nothing: «Үгүй», «байхгүй», «—». */
function saysNone(s: string): boolean {
  const t = lower(tidy(s));
  return t === '' ? false : /^(?:үгүй|байхгүй|байхгүй\.|—|-|no|none)$/u.test(t) || yesNo(t) === false;
}

function pickVertical(answer: string, t: Templates, override: string | undefined): { value: string; reason: string } {
  if (override !== undefined) return { value: override, reason: '--vertical given on the command line' };
  const a = lower(tidy(answer));
  for (const [vertical, stems] of Object.entries(t.verticals)) {
    if (vertical.startsWith('_') || !Array.isArray(stems)) continue;
    for (const stem of stems) {
      if (typeof stem !== 'string') continue;
      // Word-initial, never an unanchored substring (rule 6).
      const at = a.indexOf(lower(stem));
      if (at >= 0 && (at === 0 || !/[\p{L}\p{N}]/u.test(a[at - 1]!))) {
        return { value: vertical, reason: `1.2 «${tidy(answer)}» begins a word with «${stem}»` };
      }
    }
  }
  return { value: 'general', reason: `1.2 «${tidy(answer)}» names no known vertical — confirm, or re-run with --vertical` };
}

function variantOf(p: ParsedPrice, key: string): IntakeVariant {
  switch (p.kind) {
    case 'exact': return { variantKey: key, priceKind: 'exact', priceMin: p.min, priceMax: null, refusalTopic: null };
    case 'from': return { variantKey: key, priceKind: 'from', priceMin: p.min, priceMax: null, refusalTopic: null };
    case 'range': return { variantKey: key, priceKind: 'range', priceMin: p.min, priceMax: p.max, refusalTopic: null };
    case 'on_inspection': return { variantKey: key, priceKind: 'on_inspection', priceMin: null, priceMax: null, refusalTopic: null };
  }
}

/** The phones for a sentence: «7600 1888» or «7600 1888 эсвэл 8090 5498». */
export function phonesPhrase(phone: string): string | null {
  const parts = tidy(phone).split(/[,;\n/]+| эсвэл /u).map((p) => p.trim()).filter((p) => /\d/.test(p));
  return parts.length === 0 ? null : parts.join(' эсвэл ');
}

function fill(template: string, values: Record<string, string | null>): string | null {
  let missing = false;
  const out = template.replace(/\{([a-z_]+)\}/g, (_, k: string) => {   // ascii-safe: placeholder names in our own templates
    const v = values[k];
    if (v === null || v === undefined) { missing = true; return ''; }
    return v;
  });
  return missing ? null : nfc(out);
}

export function planFromForm(a: FormAnswers, o: PlanOptions): OnboardPlan {
  const missing: Missing[] = [];
  const manual: string[] = [];
  const notes: string[] = [];
  const need = (question: string, what: string, holdsReady = true, subject?: string, code?: string) =>
    missing.push({
      question, what, holdsReady, audience: 'client',
      ...(subject === undefined ? {} : { subject }), ...(code === undefined ? {} : { code }),
    });
  const operator = (question: string, what: string, holdsReady = true) =>
    missing.push({ question, what, holdsReady, audience: 'operator' });
  const t = (id: string) => tidy(a.text[id] ?? '');
  const c = (id: string): Choice[] => a.choices[id] ?? [];

  // ---- 1. the business ------------------------------------------------------------
  const displayName = t('1.1');
  if (displayName === '') need('1.1', 'the business name customers use');
  const vertical = pickVertical(t('1.2'), o.templates, o.vertical);
  if (vertical.value === 'general' && o.vertical === undefined) operator('1.2', vertical.reason, false);

  const contacts: { kind: string; value: string }[] = [];
  const addressAnswer = t('1.5');
  const urls = [...addressAnswer.matchAll(URL)].map((m) => m[0]);
  const maps = urls.find((u) => MAPS.test(u)) ?? null;
  const addressText = tidy(addressAnswer.replace(URL, ' '));
  if (addressText !== '') contacts.push({ kind: 'address', value: addressText });
  else need('1.5', 'the street address in words (a map link alone cannot answer «хаяг хаана вэ?», D-069)');
  if (maps !== null) contacts.push({ kind: 'maps_url', value: maps });
  const phone = t('1.6');
  if (phone !== '') contacts.push({ kind: 'phone', value: phone });
  else need('1.6', 'a phone number — every refusal and hand-off line ends at it');
  const website = t('1.7');
  if (website !== '' && !saysNone(website)) contacts.push({ kind: 'website', value: website });
  const bookingUrl = [...t('1.8').matchAll(URL)].map((m) => m[0])[0] ?? null;
  if (t('1.8') !== '' && !saysNone(t('1.8')) && bookingUrl === null) {
    need('1.8', `the booking link «${t('1.8')}» is not a web address`);
  }

  // ---- 2. channels ------------------------------------------------------------------
  const channels: ChannelPlan[] = [];
  const chosen = ticked(c('2.1'));
  if (chosen.length === 0) need('2.1', 'which channels Дали answers on (no box ticked)');
  const pageName = t('11.1');
  const pageIdInUrl = /(?:profile\.php\?id=|facebook\.com\/)(\d{6,})/u.exec(pageName)?.[1] ?? null;
  for (const ch of chosen) {
    const l = lower(ch.label);
    if (l.startsWith('facebook')) {
      const id = o.facebookPageId ?? pageIdInUrl;
      channels.push({ provider: 'facebook_page', externalId: id, label: pageName || '(no Page name given)' });
      if (id === null) {
        operator('11.1', 'the Facebook Page id (numbers). The form asks for the Page NAME; read the id off the Page\'s About section and re-run with --facebook-page-id');
      }
      if (pageName === '') need('11.1', 'the Facebook Page name, to check against the Page the token belongs to', false);
    } else if (l.startsWith('instagram')) {
      const handle = ch.extra || t('11.2');
      channels.push({ provider: 'instagram', externalId: o.instagramId ?? null, label: handle || '(no handle given)' });
      if (o.instagramId === undefined) {
        operator('2.1', `the Instagram account id for «${handle || '?'}» — Meta routes by id, not by handle; re-run with --instagram-id`, false);
      }
    } else {
      manual.push(`Website chat was ticked (${ch.extra || 'no address given'}): the web channel is set up by hand (docs/website-channel.md); this command does not create it.`);
    }
  }

  const comments = ticked(c('2.2'));
  const commentsRequested = comments.some((x) => lower(x.label).startsWith('тийм'));
  if (comments.length === 0) need('2.2', 'whether Дали replies under posts', false);
  if (t('2.3') !== '') {
    manual.push(`New-request alerts go to «${t('2.3')}» (2.3). Lead routing is not configured by this command.`);
  } else need('2.3', 'who receives new requests (name, Telegram or phone)', false);

  // ---- 3. hours -----------------------------------------------------------------------
  const hours: IntakeDocument['hours'] = [];
  const seenDays = new Set<number>();
  for (const h of a.hours) {
    const wd = WEEKDAYS[lower(h.day)];
    if (wd === undefined) { need('3', `hours row «${h.day}» is not a weekday`); continue; }
    seenDays.add(wd);
    if (isClosedWord(h.opens) || isClosedWord(h.closes)) {
      hours.push({ weekday: wd, opens: null, closes: null, closed: true });
      continue;
    }
    if (h.opens === '' && h.closes === '') { need('3', `${h.day}: opening hours left blank — open, or «Амарна»?`); continue; }
    const opens = parseClock(h.opens);
    const closes = parseClock(h.closes);
    if (opens === null || closes === null || opens >= closes) {
      need('3', `${h.day}: «${h.opens}»–«${h.closes}» is not a readable opening time`);
      continue;
    }
    hours.push({ weekday: wd, opens, closes, closed: false });
  }
  for (const [day, wd] of Object.entries(WEEKDAYS)) if (!seenDays.has(wd)) need('3', `no hours row for ${day}`);
  hours.sort((x, y) => x.weekday - y.weekday);

  // ---- 4. services and prices -----------------------------------------------------------
  const rangePolicy = ticked(c('4.2')).map((x) => lower(x.label));
  const services: IntakeService[] = [];
  const serviceNotes: string[] = [];
  const priceOnRequest: string[] = [];
  for (const s of a.services) {
    if (s.name === '') { need('4', `a price row with no service name («${s.price}»)`); continue; }
    const parsed = s.price === '' ? null : parsePriceCell(s.price);
    if (parsed === null) {
      need('4', s.price === '' ? `a price for «${s.name}»` : `«${s.name}»: the price «${s.price}» does not read as a price`,
        true, s.name, s.price === '' ? 'price' : 'price_unreadable');
      continue;
    }
    let variants = parsed.map((p) => variantOf(p.price, p.variantKey));
    if (variants.some((v) => v.priceKind === 'range')) {
      if (rangePolicy.some((l) => l.includes('эхэлнэ'))) {
        // 4.2 «...-аас эхэлнэ»: the client's own instruction — quote the lower end as a «from».
        variants = variants.map((v) => v.priceKind === 'range' ? { ...v, priceKind: 'from', priceMax: null } : v);
      } else if (rangePolicy.some((l) => l.startsWith('үнэ хэлэхгүй'))) {
        variants = variants.map((v) => v.priceKind === 'range'
          ? { ...v, priceKind: 'none', priceMin: null, priceMax: null, refusalTopic: 'price_on_request' } : v);
        priceOnRequest.push(s.name);
      } else if (rangePolicy.length === 0) {
        need('4.2', `«${s.name}» has a price range and 4.2 (how to quote a range) is unanswered — quoted as the range until answered`, false);
      }
    }
    const duration = parseDuration(s.duration);
    if (s.duration !== '' && duration === null) {
      need('4', `«${s.name}»: duration «${s.duration}» does not read as minutes or hours`, false, s.name, 'duration');
    }
    services.push({ name: s.name, category: null, durationMinutes: duration, aliases: [], variants });
    if (s.note !== '') serviceNotes.push(`${s.name}: ${s.note}`);
  }
  if (services.length === 0 && a.services.length === 0) need('4', 'the services and prices table is empty');
  if (services.length > 0) {
    need('4', 'Latin spellings customers type for the services (e.g. «budalt», «hums») — not derivable (D-067)', false, undefined, 'latin_spellings');
  }

  // ---- 5. staff ----------------------------------------------------------------------------
  const selectable = yesNo(ticked(c('5.1'))[0]?.label ?? '');
  const affects = yesNo(t('5.2'));
  if (ticked(c('5.1')).length === 0) need('5.1', 'whether customers choose staff by name', false);
  const staff: StaffRow[] = [];
  for (const s of a.staff) {
    if (s.name === '') continue;
    const active = yesNo(s.active);
    if (active === null) { need('5', `is «${s.name}» working now? («Одоо ажиллаж байгаа» is blank)`, false); continue; }
    const paren = /^(.+?)\s*\(([^()]+)\)$/u.exec(s.name);
    staff.push({
      name: paren ? paren[1]!.trim() : s.name,
      shortName: paren ? paren[2]!.trim() : null,
      tier: s.grade === '' ? null : s.grade,
      active,
      customerSelectable: selectable === true,
      affectsPrice: affects === true,
    });
  }
  if (ticked(c('5.3')).some((x) => lower(x.label).startsWith('тийм'))) {
    notes.push('5.3: the client allows Дали to recommend a specific staff member. The platform does not recommend staff today; recorded only.');
  }

  // ---- 6. booking and deposits ---------------------------------------------------------------
  const bookingWays = ticked(c('6.1')).map((x) => x.label + (x.extra ? ` (${x.extra})` : ''));
  if (bookingWays.length === 0) need('6.1', 'how customers book', false);
  const deposits: { appliesTo: string; ruleText: string }[] = [];
  const dep = t('6.2');
  if (dep === '') need('6.2', 'whether a deposit is taken, and how much (answer «Үгүй» if none)');
  else if (!saysNone(dep)) {
    if (/\d/.test(dep)) deposits.push({ appliesTo: o.templates.model_visible.deposit_label, ruleText: dep });
    else need('6.2', `«${dep}» says a deposit is taken but not how much`);
  }
  const action = ticked(c('6.4')).map((x) => lower(x.label));
  if (action.some((l) => l.includes('нэр, утас'))) {
    manual.push('6.4: the client wants Дали to take the customer\'s name and phone. Lead capture is the sales step (D-127), not configured here; until it is, Дали gives the booking line.');
  }

  // ---- 7. never say --------------------------------------------------------------------------
  const neverSay: IntakeDocument['neverSay'] = [];
  const modelVisible: OnboardPlan['modelVisible'] = [];
  const addRules = (id: string, prefix: string, responseKind: string) => {
    listItems(t(id)).filter((x) => !saysNone(x)).forEach((item, i) => {
      const question = fill(o.templates.model_visible.rule_question, { topic: item }) ?? item;
      // The client's own phrase is the stem: matched as a whole phrase at a word start, so
      // «хүүхдийн үнэ» fires on «Хүүхдийн үнэ хэд вэ» and never on «үнэ хэд вэ».
      neverSay.push({ key: `${prefix}_${i + 1}`, question, responseKind, stems: [lower(item)] });
      modelVisible.push({ where: `rule ${prefix}_${i + 1} (from ${id})`, text: question });
    });
  };
  addRules('7.1', 'never', 'refusal_topic');
  addRules('7.2', 'withhold', 'refusal_topic');
  addRules('7.3', 'handoff', 'handoff');
  if (priceOnRequest.length > 0) {
    const question = fill(o.templates.model_visible.rule_question, { topic: priceOnRequest.join(', ') }) ?? '';
    neverSay.push({ key: 'price_on_request', question, responseKind: 'refusal_price_unlisted', stems: priceOnRequest.map(lower) });
    modelVisible.push({ where: 'rule price_on_request (from 4.2 «Үнэ хэлэхгүй»)', text: question });
  }
  for (const id of ['7.1', '7.2', '7.3']) if (t(id) === '') need(id, 'left blank — answer «Үгүй» if there is nothing', false);

  // ---- 8. tone ---------------------------------------------------------------------------------
  const emoji = ticked(c('8.2')).map((x) => yesNo(x.label))[0] ?? null;
  const tone = ticked(c('8.1')).map((x) => x.label).join(', ');
  const length = ticked(c('8.3')).map((x) => x.label).join(', ');
  if (tone !== '') notes.push(`8.1 tone: ${tone}. The platform's style rules (02_style) apply to every tenant; recorded only.`);
  if (length !== '') notes.push(`8.3 length: ${length}. Brevity is a platform rule (D-081); recorded only.`);
  if (t('8.4') !== '') notes.push(`8.4 the client's current replies: «${t('8.4')}». Useful reading before signing the wording; not loaded.`);

  // ---- 9. FAQ, 10. products, 3.1 holidays, 4.3, 5.2, 6.3 → knowledge ------------------------------
  const faqs = a.faqs.filter((f) => f.question !== '' || f.answer !== '').flatMap((f) => {
    if (f.question === '' || f.answer === '') {
      need('9', `FAQ row half filled: «${f.question || f.answer}»`, false);
      return [];
    }
    return [{ question: f.question, answer: f.answer }];
  });
  const titles = o.templates.model_visible.kb_titles;
  const documents: OnboardPlan['documents'] = [];
  const doc = (key: string, body: string) => {
    const title = titles[key];
    if (title === undefined || body.trim() === '') return;
    documents.push({ key, title, body: nfc(body.trim()) });
    modelVisible.push({ where: `knowledge document title (${key})`, text: title });
  };
  doc('service_notes', serviceNotes.join('\n'));
  if (!saysNone(t('4.3'))) doc('similar_names', t('4.3'));
  if (!saysNone(t('5.2'))) doc('staff_grades', t('5.2'));
  if (t('6.3') === '') need('6.3', 'the cancellation rule (how many hours before)', false);
  else if (!saysNone(t('6.3'))) doc('cancellation', t('6.3'));
  if (t('3.1') !== '' && !saysNone(t('3.1'))) doc('holidays', t('3.1'));
  const sells = ticked(c('10.1')).some((x) => lower(x.label).startsWith('тийм'));
  if (sells) {
    // Only the client's own words: the brands. Which box they ticked in 10.2 is the form's
    // wording, not theirs, so it goes to the operator's notes rather than into the prompt.
    doc('products', t('10.3'));
    const how = ticked(c('10.2')).map((x) => x.label + (x.extra ? `: ${x.extra}` : '')).join('; ');
    if (how !== '') notes.push(`10.2 products: ${how}. No product prices are in the form; recorded only.`);
  }

  // ---- 11. access ---------------------------------------------------------------------------------
  const otherBot = ticked(c('11.3'));
  if (otherBot.some((x) => lower(x.label).startsWith('тийм'))) {
    manual.push(`11.3: another bot or auto-reply is running (${otherBot.map((x) => x.extra).filter((x) => x !== '').join(', ') || 'not named'}) — switch it off before going live, or two bots answer every customer.`);
  }
  if (!ticked(c('11.5')).some((x) => x.checked)) need('11.5', 'Page admin access not yet granted', false);

  // ---- sentences ------------------------------------------------------------------------------------
  const phones = phonesPhrase(phone);
  const wording: WordingLine[] = [];
  const sentences: Record<string, string> = {};
  const noEmoji = emoji === false;
  const kinds = Object.keys(o.templates.sentences)
    .filter((k) => k !== 'comment_public_reply' || commentsRequested);
  for (const kind of kinds) {
    const tpl = o.templates.sentences[kind]!;
    const str = (k: string) => (typeof tpl[k] === 'string' ? tpl[k] as string : null);
    const key = kind === 'booking_line'
      ? (bookingUrl !== null ? 'link' : 'phone')
      : (str(vertical.value) !== null ? vertical.value : 'default');
    const raw = str(key);
    if (raw === null) continue;
    const values = { phones, booking_url: bookingUrl, business: displayName === '' ? null : displayName };
    let body = fill(raw, values);
    if (body === null) {
      // Name the answer the sentence is waiting for; the line is not written without it.
      const needs = [...raw.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]!)   // ascii-safe: placeholder names in our own templates
        .filter((k) => values[k as keyof typeof values] === null);
      const q = needs.includes('business') ? '1.1' : needs.includes('booking_url') ? '1.8' : '1.6';
      need(q, `the «${kind}» sentence needs ${needs.includes('business') ? 'the business name (1.1)' : needs.includes('booking_url') ? 'the booking link (1.8)' : 'a phone number (1.6)'}`,
        kind === 'handoff');
      continue;
    }
    if (noEmoji) body = tidy(body.replace(EMOJI, ''));
    const approvedFor = Array.isArray(tpl['approved_bytes_for']) ? tpl['approved_bytes_for'] as string[] : [];
    const approved = (tpl['approved_bytes'] === true || approvedFor.includes(key)) && body === nfc(raw);
    sentences[kind] = body;
    wording.push({
      kind, body, template: `${kind}.${key}`, derivedFrom: str('derived_from') ?? '', alreadyApprovedBytes: approved,
      templateApproved: str('template_approved'),
    });
  }

  const intake: IntakeDocument = {
    slug: o.slug,
    business: {
      displayName: displayName || o.slug, vertical: vertical.value, timezone: 'Asia/Ulaanbaatar',
      locale: 'mn-MN', currencySymbol: '₮', currencySymbolBefore: false,
    },
    // The client's signature on the FACTS is not the form's «БӨГЛӨСӨН» block: that says who
    // filled it in. The facts are confirmed on the one-page summary, by `approve.ts`.
    confirmedBy: null,
    hours,
    services,
    contacts,
    booking: { url: bookingUrl },
    sentences,
    neverSay,
    faqs,
    staff: staff.map((s) => ({ name: s.name, shortName: s.shortName })),
    commentRules: [],
  };

  if (a.signer.name === '') need('БӨГЛӨСӨН', 'who filled the form (name, title, date, phone) — the person who will confirm the facts', false);

  return {
    intake, staff, deposits, documents, channels,
    replyStyle: noEmoji ? { max_emoji: 0 } : null,
    wording, modelVisible, missing, manual, notes, vertical,
    signer: a.signer,
    branch: { count: t('1.3'), thisPage: t('1.4') },
    commentsRequested,
  };
}
