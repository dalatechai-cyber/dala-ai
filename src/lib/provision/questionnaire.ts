/**
 * «Дали — Мэдээлэл цуглуулах маягт», read.
 *
 * `formFile.ts` turns the client's file into paragraphs and tables. This file knows the
 * questionnaire's layout — numbered questions («1.5 Хаяг»), the hours, services, staff and
 * FAQ tables, the ticked boxes, the signature block — and returns what the client ANSWERED,
 * question by question, plus the list of questions nobody answered.
 *
 * ## It refuses to read a form it does not recognise
 *
 * Every numbered question is found by its number AND checked against its expected label.
 * A form whose «1.5» is no longer «Хаяг» is a different version of the questionnaire, and
 * reading it by number would put a phone number where the address goes. That is D-057: a
 * reader that cannot finish says so; it never answers with the part it managed. The
 * problems are returned together, so one run lists all of them.
 *
 * ## It interprets nothing it does not have to
 *
 * An answer is the client's text, NFC-normalised, whitespace tidied. Prices, times and
 * durations are parsed where the shape is unambiguous; anything else is kept as text and
 * reported, never coerced. `plan.ts` decides what each answer becomes.
 */
import { nfc } from '../mn/text.ts';
import type { FormBlock } from './formFile.ts';

/** The numbered questions this reader knows, and a label fragment each must carry. */
export const FORM_FIELDS: Readonly<Record<string, string>> = {
  '1.1': 'Байгууллагын нэр',
  '1.2': 'Үйл ажиллагааны чиглэл',
  '1.3': 'Салбарын тоо',
  '1.4': 'аль салбарынх',
  '1.5': 'Хаяг',
  '1.6': 'Холбоо барих утас',
  '1.7': 'Вэбсайт',
  '1.8': 'Цаг захиалгын холбоос',
  '2.1': 'Сувгууд',
  '2.2': 'сэтгэгдэлд хариулах',
  '2.3': 'Шинэ хүсэлт',
  '3.1': 'Баярын өдрүүдэд',
  '4.1': 'тогтмол биш',
  '4.2': 'яаж хариулах',
  '4.3': 'Ижил төстэй нэртэй',
  '5.1': 'нэрээр нь сонгодог',
  '5.2': 'зэрэг үнэд нөлөөлдөг',
  '5.3': 'санал болгож болох',
  '6.1': 'яаж цаг захиалдаг',
  '6.2': 'Урьдчилгаа төлбөр',
  '6.3': 'Цуцлах журам',
  '6.4': 'Дали юу хийх',
  '7.1': 'хэзээ ч хэлж болохгүй',
  '7.2': 'хэлэх ёсгүй мэдээлэл',
  '7.3': 'ажилтанд шилжүүлэх',
  '8.1': 'хэрхэн ярих',
  '8.2': 'Эможи',
  '8.3': 'Хариултын урт',
  '8.4': 'хариултын жишээ',
  '10.1': 'Бүтээгдэхүүн зардаг',
  '10.2': 'үнийг хэлэх',
  '10.3': 'брэндүүд',
  '11.1': 'Facebook хуудасны нэр',
  '11.2': 'Instagram хаяг',
  '11.3': 'өөр бот',
  '11.4': 'Админ эрх олгох',
  '11.5': 'Эрх олгосон',
  '11.6': 'бусад хүмүүс',
};

export type Choice = { label: string; checked: boolean; extra: string };

export type HoursRow = { day: string; opens: string; closes: string };
export type ServiceRow = { name: string; price: string; duration: string; note: string };
export type StaffRow = { name: string; grade: string; branch: string; active: string };

export type FormAnswers = {
  /** Free-text answers by question number, '' when left blank. */
  text: Record<string, string>;
  /** Checkbox answers by question number, for the questions that have boxes. */
  choices: Record<string, Choice[]>;
  hours: HoursRow[];
  services: ServiceRow[];
  staff: StaffRow[];
  faqs: { question: string; answer: string }[];
  signer: { name: string; title: string; date: string; phone: string };
};

export type LayoutProblem = { where: string; detail: string };

const NUMBERED = /^(\d{1,2}\.\d{1,2})(?![\p{N}])\s+(.*)$/su;
const TICKED = /^(?:[☒☑✅✔✓■▣]|\[[xXхХ]\]|[xXхХ](?=\s))/u;
const BOX = /^(?:[☐☒☑✅✔✓■□▢▣]|\[[ xXхХ]?\]|[xXхХ](?=\s))/u;

const tidy = (s: string): string => nfc(s).replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').trim();
const firstLine = (s: string): string => tidy(s).split('\n')[0] ?? '';
const lower = (s: string): string => s.toLocaleLowerCase('mn');

/** Dotted fill-in blanks («хаяг: .......») are the form's, not the client's. */
function stripBlanks(s: string): string {
  return s.replace(/[.…_]{3,}/gu, ' ').replace(/[ \t]+/g, ' ').trim();
}

/**
 * The boxes in a checkbox cell. Each option line starts with a box; the client ticks one
 * by replacing ☐ with ☒/☑/✓ (Word's checkbox control reads as ☒ when ticked, see
 * `formFile.ts`). `extra` is anything the client wrote into the option's own blank —
 * «Instagram (хаяг: @tara.parkod)».
 */
export function readChoices(cell: string): Choice[] | null {
  const lines = tidy(cell).split('\n').filter((l) => l !== '');
  if (lines.length === 0 || !lines.some((l) => BOX.test(l))) return null;
  return lines.filter((l) => BOX.test(l)).map((l) => {
    const checked = TICKED.test(l);
    const rest = l.replace(BOX, '').trim();
    // «Instagram (хаяг: …)», «Бусад: …», «Холбоос өгнө: …», «Тийм — аль нь: …»
    const colon = rest.indexOf(':');
    const label = stripBlanks(colon === -1 ? rest : rest.slice(0, colon)).replace(/\($/u, '').trim();
    const extra = colon === -1 ? '' : stripBlanks(rest.slice(colon + 1)).replace(/\)$/u, '').trim();
    return { label, checked, extra };
  });
}

const isHeader = (row: string[], ...cells: string[]): boolean =>
  cells.every((c, i) => lower(firstLine(row[i] ?? '')).startsWith(lower(c)));

const blank = (row: string[]): boolean => row.every((c) => tidy(c) === '');

/**
 * Read the questionnaire's answers out of its blocks, or say why the layout is not the one
 * this reader knows.
 */
export function readQuestionnaire(blocks: readonly FormBlock[]):
  { ok: true; answers: FormAnswers } | { ok: false; problems: LayoutProblem[] } {
  const problems: LayoutProblem[] = [];
  const text: Record<string, string> = {};
  const choices: Record<string, Choice[]> = {};
  const seen = new Set<string>();
  const answers: FormAnswers = {
    text, choices, hours: [], services: [], staff: [], faqs: [],
    signer: { name: '', title: '', date: '', phone: '' },
  };
  let tables = { hours: false, services: false, staff: false, faqs: false, signer: false };

  for (const b of blocks) {
    if (b.type !== 'table') continue;
    const rows = b.rows;
    const head = rows[0] ?? [];

    if (isHeader(head, 'Өдөр', 'Нээх', 'Хаах')) {
      tables = { ...tables, hours: true };
      for (const r of rows.slice(1)) {
        answers.hours.push({ day: tidy(r[0] ?? ''), opens: tidy(r[1] ?? ''), closes: tidy(r[2] ?? '') });
      }
      continue;
    }
    if (isHeader(head, 'Үйлчилгээний нэр', 'Үнэ', 'Хугацаа', 'Тайлбар')) {
      tables = { ...tables, services: true };
      for (const r of rows.slice(1)) {
        if (blank(r)) continue;
        answers.services.push({
          name: tidy(r[0] ?? ''), price: tidy(r[1] ?? ''), duration: tidy(r[2] ?? ''), note: tidy(r[3] ?? ''),
        });
      }
      continue;
    }
    if (isHeader(head, 'Нэр', 'Зэрэг', 'Салбар', 'Одоо ажиллаж')) {
      tables = { ...tables, staff: true };
      for (const r of rows.slice(1)) {
        if (blank(r)) continue;
        answers.staff.push({
          name: tidy(r[0] ?? ''), grade: tidy(r[1] ?? ''), branch: tidy(r[2] ?? ''), active: tidy(r[3] ?? ''),
        });
      }
      continue;
    }
    if (isHeader(head, 'Асуулт', 'Хариулт') && head.length === 2) {
      tables = { ...tables, faqs: true };
      for (const r of rows.slice(1)) {
        if (blank(r)) continue;
        answers.faqs.push({ question: tidy(r[0] ?? ''), answer: tidy(r[1] ?? '') });
      }
      continue;
    }
    // The signature block: four label rows, no numbers.
    const labels = rows.map((r) => lower(firstLine(r[0] ?? '')));
    if (labels.length >= 3 && labels[0] === 'нэр' && labels.includes('огноо')) {
      tables = { ...tables, signer: true };
      const val = (l: string) => tidy(rows.find((r) => lower(firstLine(r[0] ?? '')) === l)?.[1] ?? '');
      answers.signer = { name: val('нэр'), title: val('албан тушаал'), date: val('огноо'), phone: val('утас') };
      continue;
    }

    for (const r of rows) {
      if (r.length < 2) continue;
      const m = NUMBERED.exec(firstLine(r[0] ?? ''));
      if (m === null) continue;
      const id = m[1]!;
      const expected = FORM_FIELDS[id];
      if (expected === undefined) {
        problems.push({ where: id, detail: `question «${firstLine(r[0] ?? '')}» is not one this reader knows — a newer form?` });
        continue;
      }
      if (!lower(tidy(r[0] ?? '')).includes(lower(expected))) {
        problems.push({ where: id, detail: `expected «${expected}» here, found «${firstLine(r[0] ?? '')}» — the form's numbering has changed` });
        continue;
      }
      if (seen.has(id)) {
        problems.push({ where: id, detail: 'appears twice' });
        continue;
      }
      seen.add(id);
      const cell = r.slice(1).join('\n');
      const boxes = readChoices(cell);
      if (boxes !== null) choices[id] = boxes;
      else text[id] = tidy(cell);
    }
  }

  for (const id of Object.keys(FORM_FIELDS)) {
    if (!seen.has(id)) problems.push({ where: id, detail: `question «${id} ${FORM_FIELDS[id]}» was not found in the file` });
  }
  for (const [k, found] of Object.entries(tables)) {
    if (!found) problems.push({ where: k, detail: `the ${k} table was not found in the file` });
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, answers };
}

// ---- value parsers ------------------------------------------------------------
// Each returns null when the text is not unambiguously the thing asked for. Null is a
// result: the caller records the answer as unreadable and asks, rather than guessing.

/** «10:00», «10.00», «10 цаг», «9:30» → "HH:MM". */
export function parseClock(s: string): string | null {
  const t = tidy(s).replace(/\s*цаг(?:т|аас)?$/u, '');
  const m = /^(\d{1,2})(?:[:.](\d{2}))?$/u.exec(t);
  if (m === null) return null;
  const h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min !== 0)) return null;
  // `business_hours.closes` is a `time`; 24:00 is written as 23:59, the last minute of the day.
  if (h === 24) return '23:59';
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

const CLOSED_WORDS = ['амарна', 'амралт', 'амардаг', 'хаалттай', 'ажиллахгүй'];
export const isClosedWord = (s: string): boolean => CLOSED_WORDS.some((w) => lower(tidy(s)).startsWith(w));

/** Postgres `dow`: 0 = Sunday. */
export const WEEKDAYS: Readonly<Record<string, number>> = {
  'даваа': 1, 'мягмар': 2, 'лхагва': 3, 'пүрэв': 4, 'баасан': 5, 'бямба': 6, 'ням': 0,
};

/** «1 цаг» 60 · «1.5 цаг» 90 · «45 мин» 45 · «1 цаг 30 мин» 90. A range is not a duration. */
export function parseDuration(s: string): number | null {
  const t = lower(tidy(s)).replace(',', '.');
  if (t === '') return null;
  const m = /^(?:(\d+(?:\.\d+)?)\s*цаг)?\s*(?:(\d+)\s*мин(?:ут)?)?$/u.exec(t);
  if (m === null || (m[1] === undefined && m[2] === undefined)) return null;
  const minutes = Math.round(Number(m[1] ?? 0) * 60) + Number(m[2] ?? 0);
  return minutes > 0 ? minutes : null;
}

export type ParsedPrice =
  | { kind: 'exact'; min: string }
  | { kind: 'from'; min: string }
  | { kind: 'range'; min: string; max: string }
  | { kind: 'on_inspection' };

/**
 * One price as the client wrote it. «55,000₮» exact · «176,000–200,000₮» range ·
 * «45,000₮-аас» / «45,000₮-с эхэлнэ» from · «Үзлэгээр» on inspection. Anything else is null:
 * a price is the one fact this platform must never invent (D-075).
 */
export function parsePrice(s: string): ParsedPrice | null {
  const t = lower(tidy(s));
  if (t === '') return null;
  if (/^(?:үзлэгээр|үзэж байж|үзсэний дараа)/u.test(t)) return { kind: 'on_inspection' };
  // Digits grouped with spaces, commas, dots or apostrophes: «55,000», «55 000», «55.000».
  const nums = [...t.matchAll(/\d{1,3}(?:[ ,.'’]\d{3})+(?!\d)|\d+/gu)].map((m) => m[0].replace(/[ ,.'’]/gu, ''));
  const rest = t.replace(/\d{1,3}(?:[ ,.'’]\d{3})+(?!\d)|\d+/gu, ' ')
    .replace(/₮|төгрөг|төг|mnt|tug/gu, ' ').replace(/[\s()]+/gu, ' ').trim();
  const from = /^-?(?:аас|ээс|оос|өөс|с)?\s*(?:эхэлнэ|эхлэн|дээш)?$/u;
  if (nums.length === 1) {
    if (rest === '') return { kind: 'exact', min: nums[0]! };
    if (rest === '+' || (/^-?(?:аас|ээс|оос|өөс|с)(?:\s|$)/u.test(rest) && from.test(rest)) || /^(?:эхэлнэ|дээш)$/u.test(rest)) {
      return { kind: 'from', min: nums[0]! };
    }
    return null;
  }
  if (nums.length === 2 && /^(?:[-–—~]|-?(?:аас|ээс|оос|өөс|с) .*хүртэл)$/u.test(rest)) {
    const [a, b] = [nums[0]!, nums[1]!];
    if (Number(a) >= Number(b)) return null;
    return { kind: 'range', min: a, max: b };
  }
  return null;
}

/**
 * A price cell that names tiers, one per line: «Мастер: 66,000₮» / «1-р зэрэг: 55,000₮».
 * Returns null when any line does not read — never the lines that did.
 */
export function parsePriceCell(s: string): { variantKey: string; price: ParsedPrice }[] | null {
  const lines = tidy(s).split('\n').filter((l) => l !== '');
  if (lines.length === 0) return null;
  if (lines.length === 1 && !/:/u.test(lines[0]!)) {
    const p = parsePrice(lines[0]!);
    return p === null ? null : [{ variantKey: '', price: p }];
  }
  const out: { variantKey: string; price: ParsedPrice }[] = [];
  for (const l of lines) {
    const i = l.lastIndexOf(':');
    if (i <= 0) return null;
    const key = l.slice(0, i).trim();
    const p = parsePrice(l.slice(i + 1));
    if (key === '' || p === null) return null;
    out.push({ variantKey: key, price: p });
  }
  return new Set(out.map((o) => o.variantKey)).size === out.length ? out : null;
}

/** «Тийм»/«Үгүй»/tick, or null when the answer is neither. */
export function yesNo(s: string): boolean | null {
  const t = lower(tidy(s));
  if (/^(?:тийм|тиймээ|yes|✓|✔|☑|☒|x)(?![\p{L}])/u.test(t)) return true;
  if (/^(?:үгүй|no|-|—)(?![\p{L}])/u.test(t)) return false;
  return null;
}

/** The ticked options of a checkbox question, by label prefix. */
export function ticked(choices: readonly Choice[] | undefined): Choice[] {
  return (choices ?? []).filter((c) => c.checked);
}
