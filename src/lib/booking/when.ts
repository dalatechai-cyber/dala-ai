/**
 * «Маргааш 2 цагт», «баасан гарагт оройн 6», «10 сарын 15-нд 14:00», «margaash 14 tsagt»: the
 * day and the time a customer typed, if they typed one. Pure; no model.
 *
 * A word counts only as a whole word (Rule 6: no `\b`, no unanchored substring): «Нямбаяр» is a
 * name, not Sunday. A day word may carry the usual case endings («маргаашийн», «баасанд»). What
 * cannot be read is null, never a guess: the customer is asked again.
 *
 * The hour is kept as typed, plus whether the customer said evening. Whether «2» means 14:00 is
 * decided against the day's opening hours by `hourOn`, because only the hours know.
 */
import { fold } from '../mn/text.ts';
import { nextLocalDate } from '../reception/daySlots.ts';

export type Want = {
  /** `YYYY-MM-DD` on the tenant's clock, or null when no day was named. */
  date: string | null;
  /** Hour and minute as typed (`2` stays 2), or null when no time was named. */
  hour: number | null;
  minute: number;
  /** «орой», «үдээс хойш»: an hour before noon means the afternoon. */
  afternoon: boolean;
  /** «өглөө», «үдээс өмнө»: the hour is taken as typed, never moved to the afternoon. */
  morning?: boolean;
};

/** Words, by whole word. Case endings a day word may carry, Cyrillic and Latin. */
const ENDINGS = ['', 'д', 'т', 'нд', 'ны', 'ний', 'ын', 'ийн', 'гийн', 'аас', 'ээс', 'оос', 'өөс',
  'd', 't', 'nd', 'nii', 'iin', 'giin', 'aas', 'ees', 'oos'];

const TODAY = ['өнөөдөр', 'өнөөдр', 'unuudur', 'unuudr', 'onoodor', 'onoodr', 'önöödör'];
const TOMORROW = ['маргааш', 'margaash', 'margash'];
const DAY_AFTER = ['нөгөөдөр', 'нөгөөдр', 'nuguudur', 'nuguudr', 'nogoodor', 'nögöödör'];
/** JavaScript weekday (0 = Sunday) by its Mongolian name. */
const WEEKDAY_WORDS: readonly (readonly [number, readonly string[]])[] = [
  [0, ['ням', 'nyam']],
  [1, ['даваа', 'davaa']],
  [2, ['мягмар', 'myagmar', 'mygmar']],
  [3, ['лхагва', 'lhagva', 'lkhagva']],
  [4, ['пүрэв', 'purev', 'pürev']],
  [5, ['баасан', 'baasan']],
  [6, ['бямба', 'byamba', 'bymba']],
];
/** Evening words. «үдээс» alone is not one: «үдээс өмнө» is the morning, «үдээс хойш» the afternoon. */
const EVENING = ['орой', 'оройн', 'үдэш', 'oroi', 'oroin', 'udesh'];
const MORNING = ['өглөө', 'өглөөний', 'ugluu', 'ogloo', 'ugluunii'];
const NOON = ['үдээс', 'udees'];
const AFTER = ['хойш', 'hoish'];
const BEFORE = ['өмнө', 'umnu', 'omno'];
/** «маргааш биш»: a day the customer is ruling out, not asking for. */
const NOT = ['биш', 'bish'];

function words(text: string): string[] {
  return fold(text).split(/[^\p{L}\p{N}]+/u).filter((w) => w !== '');
}

function isWord(word: string, stems: readonly string[]): boolean {
  return stems.some((s) => word.startsWith(s) && ENDINGS.includes(word.slice(s.length)));
}

/** A word followed directly by one of `next` («үдээс хойш»). */
function followedBy(ws: readonly string[], first: readonly string[], next: readonly string[]): boolean {
  return ws.some((w, i) => first.includes(w) && i + 1 < ws.length && next.includes(ws[i + 1] as string));
}

function addDays(date: string, n: number): string | null {
  let d: string | null = date;
  for (let i = 0; i < n && d !== null; i += 1) d = nextLocalDate(d)?.date ?? null;
  return d;
}

/** A real calendar date `YYYY-MM-DD`, or null («2 сарын 30» is not one). */
function realDate(y: number, m: number, d: number): string | null {
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const NOT_DIGIT_BEFORE = '(?<![\\p{L}\\p{N}])';
/** Also not after «:» or «.»: the «30» of «14:30-нд» is minutes, never a day of the month. */
const NOT_TIME_BEFORE = '(?<![\\p{L}\\p{N}:.])';

/**
 * The day and time in a message. `today` is the tenant's local date and weekday. Weekday names
 * are read only when `weekdays` is set: in a first message «Баасан» is as likely a name.
 *
 * Two different days in one message («маргааш биш, нөгөөдөр», «маргааш 11-нд»), a day ruled
 * out («биш»), or morning and evening together are not guessed between: null, asked again.
 */
export function parseWhen(text: string, today: { date: string; weekday: number }, opts: { weekdays: boolean } = { weekdays: true }): Want | null {
  const t = fold(text);
  const ws = words(text);
  if (ws.some((w) => NOT.includes(w))) return null;

  const named: string[] = [];
  if (ws.some((w) => isWord(w, TODAY))) named.push(today.date);
  if (ws.some((w) => isWord(w, TOMORROW))) named.push(addDays(today.date, 1) ?? '');
  if (ws.some((w) => isWord(w, DAY_AFTER))) named.push(addDays(today.date, 2) ?? '');
  if (opts.weekdays) {
    for (const [dow, stems] of WEEKDAY_WORDS) {
      if (ws.some((w) => isWord(w, stems))) named.push(addDays(today.date, (dow - today.weekday + 7) % 7) ?? '');
    }
  }

  // «10 сарын 15», «10-р сарын 15-нд», «10 sariin 15»: month first, as Mongolian writes it.
  const md = new RegExp(`${NOT_TIME_BEFORE}(\\d{1,2})\\s*(?:-?\\s*(?:р|r)\\s*)?(?:сар(?:ын|ийн)?|sar(?:iin|in)?)\\s*(\\d{1,2})(?!\\p{N})`, 'u').exec(t);
  // «15-нд», «15нд», «15-ны»: a day of this month (or next, if it has passed).
  const dom = md === null ? new RegExp(`${NOT_TIME_BEFORE}(\\d{1,2})\\s*-?\\s*(?:нд|ны|ний|nd)(?![\\p{L}\\p{N}])`, 'u').exec(t) : null;
  const [ty, tm] = today.date.split('-').map(Number) as [number, number];
  if (md !== null) {
    const m = Number(md[1]);
    const d = Number(md[2]);
    const thisYear = realDate(ty, m, d);
    const date = thisYear !== null && thisYear >= today.date ? thisYear : realDate(ty + 1, m, d);
    if (date === null) return null;
    named.push(date);
  } else if (dom !== null) {
    const d = Number(dom[1]);
    const thisMonth = realDate(ty, tm, d);
    const date = thisMonth !== null && thisMonth >= today.date ? thisMonth : (tm === 12 ? realDate(ty + 1, 1, d) : realDate(ty, tm + 1, d));
    if (date === null) return null;
    named.push(date);
  }
  if (new Set(named).size > 1 || named.includes('')) return null;
  const date = named[0] ?? null;

  const evening = ws.some((w) => isWord(w, EVENING)) || followedBy(ws, NOON, AFTER);
  const morning = ws.some((w) => isWord(w, MORNING)) || followedBy(ws, NOON, BEFORE);
  if (evening && morning) return null;

  // The time: «14:00», «14.30», «14 цагт», «2 цаг», «2 цаг хагаст», «2 цаг 30 минутад», «14ц».
  // «цаг» is a whole word with the endings of a time («цагт», «цагаас»), so «2 цагийн дараа»
  // (in two hours) is not two o'clock.
  const withoutDate = md !== null ? t.replace(md[0], ' ') : dom !== null ? t.replace(dom[0], ' ') : t;
  let hour: number | null = null;
  let minute = 0;
  const hm = new RegExp(`${NOT_DIGIT_BEFORE}(\\d{1,2})\\s*[:.]\\s*(\\d{2})(?!\\p{N})`, 'u').exec(withoutDate);
  const h = hm === null
    ? new RegExp(`${NOT_DIGIT_BEFORE}(\\d{1,2})\\s*(?:цаг(?:т|аас)?|tsag(?:t|aas)?|ц)(?![\\p{L}\\p{N}])(?:\\s*(хагас\\p{L}*|hagas\\p{L}*)|\\s*(\\d{1,2})\\s*(?:мин|min)\\p{L}*)?`, 'u').exec(withoutDate)
    : null;
  if (hm !== null) {
    hour = Number(hm[1]);
    minute = Number(hm[2]);
  } else if (h !== null) {
    hour = Number(h[1]);
    minute = h[2] !== undefined ? 30 : h[3] !== undefined ? Number(h[3]) : 0;
  } else {
    // A bare number: the whole message («14»), or one number ending a message that names a day
    // or the part of the day («маргааш 14», «оройн 7»). «Маргааш 2 хүн» is two people.
    const bare = [...withoutDate.matchAll(new RegExp(`${NOT_DIGIT_BEFORE}(\\d{1,2})(?!\\p{N})`, 'gu'))];
    const last = new RegExp(`${NOT_DIGIT_BEFORE}(\\d{1,2})[\\s.!?]*$`, 'u').exec(withoutDate);
    const anchored = date !== null || evening || morning;
    if (/^\s*\d{1,2}\s*$/u.test(withoutDate) || (anchored && bare.length === 1 && last !== null)) hour = Number(bare[0]?.[1]);
  }
  // Not a time («маргааш 50»): the day still stands, the hour is asked by the times offered.
  if (hour !== null && (hour > 23 || minute > 59)) {
    hour = null;
    minute = 0;
  }

  if (date === null && hour === null) return null;
  return { date, hour, minute, afternoon: evening, ...(morning ? { morning: true } : {}) };
}

/**
 * The typed hour as minutes after midnight on a day that opens and closes at these minutes:
 * «2» is 14:00 when the salon is shut at 2 and open at 14, or when the customer said evening.
 * Said morning, it is the hour as typed.
 */
export function hourOn(want: Want, opensMinute: number, closesMinute: number): number | null {
  if (want.hour === null) return null;
  const asTyped = want.hour * 60 + want.minute;
  if (want.morning === true) return asTyped;
  if (want.hour < 12 && (want.afternoon || (asTyped < opensMinute && asTyped + 12 * 60 < closesMinute))) return asTyped + 12 * 60;
  return asTyped;
}
