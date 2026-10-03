/**
 * One customer message inside a booking: which question it answers, and what Дали asks next.
 *
 * No model. Every line is a signed block (`wording.ts`) filled from the tenant's rows and the
 * calendar; every choice is a button (Messenger quick reply) whose title is also accepted when
 * typed. A message that answers none of the buttons is asked again once, then the flow steps
 * aside and the ordinary Дали answers it: a customer who changed the subject is never trapped.
 *
 * The steps: who it is for (the gender rule; «Хүүхэд» leads to the children's services) → service
 * group → service → stylist or «any» of a
 * level → WHEN (Дали asks the day and time; the customer types «маргааш 2 цагт» or taps a day)
 * → the free times nearest to what they asked, read from the real calendar → name → phone →
 * the summary with the deposit and Tara's terms, «Зөвшөөрч, захиалах» → hold, invoice,
 * «Төлбөр төлөх». A day and time already named in the first message («маргааш 14 цагт цаг
 * авъя») is used without asking again. A customer silent on the offered times is asked once
 * more (`followUps`). What happens after the pay button is `engine.ts`.
 */
import { markRefused, replyDedupKey } from '../outbound/claim.ts';
import { readThreadState } from '../handover/record.ts';
import { formatMnt } from '../billing/templates.ts';
import { fold } from '../mn/text.ts';
import type { QuickReply } from '../meta/send.ts';
import type { BusinessHours, Closure } from '../reception/volatile.ts';
import { tenantClock } from '../time/clock.ts';
import { eventIdForHold } from './calendar.ts';
import {
  allServices, bookingEnvMode, customerMode, depositFor, entryFires, QUICK_REPLY_TITLE_MAX, stylistButton,
  type BookingConfig, type Gender, type Stylist,
} from './config.ts';
import {
  bookingEvent, currentInvoice, dayLabel, deliverDrafted, expireHold, marked, removeOurEvent, settleHold, START, stylistLabel, timeLabel, type BookingPorts,
} from './engine.ts';
import { payUrl } from './links.ts';
import { freeStarts, isFree, openDays, type Interval, type OpenDay } from './slots.ts';
import {
  acquireHold, activeHolds, applyTurn, closeSessionRow, conversationMovedOn, endHold, markFollowedUp, rebookHold, openSession, readConfig, readHold, readHoursAndClosures,
  outboundCreatedAt, readOpenSession, readTenantFacts, REBOOK_OFFER_MINUTES, sessionHold, sessionsToFollowUp, setCalendarState, type Hold, type Session, type TenantFacts,
} from './store.ts';
import { hourOn, parseWhen, type Want } from './when.ts';
import { missingBlocks, say } from './wording.ts';

export type TurnInput = {
  tenantId: string;
  channelId: string;
  conversationId: string;
  psid: string;
  /** Meta's `mid`: the reply is keyed by it, like every reply. */
  mid: string;
  text: string;
  quickReplyPayload?: string;
  /** The message with the tenant's Latin spellings replaced (`mn/chat.ts`), or null. */
  respelled: string | null;
  hours: readonly BusinessHours[];
  closures: readonly Closure[];
};

export type TurnResult =
  | { handled: false; reason: string }
  | { handled: true; outboundId: string | null; quickReplies: QuickReply[]; linkButtonTitle?: string; detail: string };

/** A session idle this long is over (except while a payment is pending). */
export const SESSION_IDLE_MINUTES = 30;

/** A customer silent this long on the offered times is asked once more (`followUps`). */
export const FOLLOW_UP_MINUTES = 10;

/** The longest one follow-up may take: the calendar read (10 s timeout) and the send. */
const ONE_FOLLOW_UP_MS = 20_000;

type Offer = { t: string; v: string };
type Step = 'group' | 'service' | 'gender' | 'stylist' | 'when' | 'time' | 'name' | 'phone' | 'agree' | 'pay' | 'rebook';
type Reply = { step: Step; body: string; offers: Offer[]; data: Record<string, unknown>; close: string | null; linkButtonTitle?: string };

const CANCEL = 'bk:cancel';

/** Typed text compared with a button's title: folded, spaces collapsed, end punctuation dropped. */
export function sameChoice(a: string, b: string): boolean {
  const n = (s: string) => fold(s).replace(/\s+/gu, ' ').replace(/^[\s«"'(]+|[\s.,!?»"')]+$/gu, '');
  return n(a) !== '' && n(a) === n(b);
}

/** `14`, `14:00`, `14.00`, `14 цаг` → `14:00`; anything else null. */
export function typedTime(text: string): string | null {
  const t = fold(text).trim();
  const m = /^(\d{1,2})(?:\s*[:.]\s*(\d{2}))?(?:\s*(?:цаг|tsag))?$/u.exec(t);
  if (m === null) return null;
  const h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** Eight digits, from «9911 2233», «9911-2233» or «+976 99112233»; else null. */
export function typedPhone(text: string): string | null {
  const digits = text.replace(/[\s\-().]/gu, '').replace(/^\+?976(?=\d{8}$)/u, '');
  return /^\d{8}$/u.test(digits) ? digits : null;
}

/**
 * Is this a name rather than a question or a sentence? No question mark, at most four words.
 * («Урьдчилгаа хэд вэ?» is a question; «Болд» and «Б. Сараа» are names.)
 */
export function looksLikeName(text: string): boolean {
  const t = text.normalize('NFC').trim();
  return !t.includes('?') && t.split(/\s+/u).filter((x) => x !== '').length <= 4;
}

/** A name: one to sixty characters with at least one letter. */
export function typedName(text: string): string | null {
  const t = text.normalize('NFC').trim().replace(/\s+/gu, ' ');
  const len = [...t].length;
  return len >= 1 && len <= 60 && /\p{L}/u.test(t) ? t : null;
}

/**
 * A button carries its VALUE, not its place in the list: the offers can change under a button
 * already on the customer's screen (the follow-up re-reads the calendar), and a tap must still
 * mean the time it showed, never whatever moved into its position.
 */
function quickReplies(step: Step, offers: readonly Offer[], cancelTitle: string): QuickReply[] {
  return [...offers.map((o) => ({ title: o.t, payload: `bk:${step}:${o.v}` })), { title: cancelTitle, payload: CANCEL }];
}

/** Which offer, if any, this message picks. */
/**
 * Which offer, if any, this message picks. A tapped button of this step whose value is no longer
 * on offer is `stale`, and is never matched by its title instead: «12:00» on an old button means
 * 12:00 on the day it was offered for, not 12:00 on whatever day is on offer now.
 */
function picked(session: Session, input: TurnInput, cancelTitle: string): Offer | 'cancel' | { stale: string } | null {
  const offers = Array.isArray(session.data['offers']) ? (session.data['offers'] as Offer[]) : [];
  const p = input.quickReplyPayload;
  // «Цуцлах», tapped or typed, at every step: typing it is never taken as a name or a phone.
  if (p === CANCEL || sameChoice(input.text, cancelTitle)) return 'cancel';
  if (p !== undefined && p.startsWith(`bk:${session.step}:`)) {
    const v = p.slice(`bk:${session.step}:`.length);
    const hit = offers.find((o) => o.v === v);
    return hit !== undefined ? hit : { stale: v };
  }
  const typed = offers.find((o) => sameChoice(o.t, input.text));
  if (typed !== undefined) return typed;
  if (session.step === 'time') {
    const t = typedTime(input.text);
    const hit = t === null ? undefined : offers.find((o) => o.t === t);
    if (hit !== undefined) return hit;
  }
  return null;
}

// ---------------------------------------------------------------------------
// What can be offered
// ---------------------------------------------------------------------------

function stylistsFor(config: BookingConfig, gender: Gender | null): Stylist[] {
  return config.stylists.filter((s) => !config.genderRule || gender === null || s.gender === gender);
}

/** The stylists a choice stands for: one, or every stylist of a level, in the tenant's order. */
function candidates(config: BookingConfig, data: Record<string, unknown>): Stylist[] {
  const choice = String(data['stylist'] ?? '');
  const gender = (data['gender'] === 'male' || data['gender'] === 'female') ? data['gender'] as Gender : null;
  if (choice.startsWith('s:')) return config.stylists.filter((s) => s.calendarId === choice.slice(2));
  if (choice.startsWith('any:')) return stylistsFor(config, gender).filter((s) => s.level === choice.slice(4));
  return [];
}

function stylistOffers(ports: BookingPorts, config: BookingConfig, gender: Gender | null): Offer[] {
  const list = stylistsFor(config, gender);
  const offers: Offer[] = [];
  for (const level of config.levels) {
    const of = list.filter((s) => s.level === level.key);
    // «Any stylist of this level», when its approved words fit a button; when they do not
    // (Meta cuts a title at 20 characters), only the named stylists are offered.
    const any = say(ports.wording, 'booking_any_of_level', { level: level.label });
    if (of.length >= 2 && [...any].length <= QUICK_REPLY_TITLE_MAX) offers.push({ t: any, v: `any:${level.key}` });
    for (const s of of) offers.push({ t: stylistButton(s, level), v: `s:${s.calendarId}` });
  }
  return offers.slice(0, 12);
}

/** Busy time on these calendars: Google's, plus every active hold (which Google may not show yet). */
async function busyOn(ports: BookingPorts, calendars: readonly string[], from: Date, to: Date): Promise<Map<string, Interval[]> | null> {
  const [g, h] = await Promise.all([ports.calendar.busy(calendars, from, to), activeHolds(ports.db, calendars, from, to)]);
  if (!g.ok) {
    ports.log('error', 'booking_calendar_busy_failed', { detail: g.detail });
    return null;
  }
  if (!h.ok) {
    ports.log('error', 'booking_holds_unreadable', { detail: h.detail });
    return null;
  }
  const out = new Map<string, Interval[]>();
  for (const id of calendars) out.set(id, [...(g.busy.get(id) ?? []), ...(h.busy.get(id) ?? [])]);
  return out;
}

type Ctx = { ports: BookingPorts; config: BookingConfig; facts: TenantFacts; input: TurnInput; now: Date };

type DayStarts = { day: OpenDay; starts: Date[] };

/**
 * Every open day ahead with its free starts for this service on any of the chosen stylists, from
 * one read of the calendars and the holds. Null: the calendar cannot be read.
 */
async function freeByDay(c: Ctx, data: Record<string, unknown>): Promise<DayStarts[] | null> {
  const minutes = Number(data['minutes']);
  const who = candidates(c.config, data);
  const days = openDays({ now: c.now, timezone: c.facts.timezone, daysAhead: c.config.daysAhead, hours: c.input.hours, closures: c.input.closures });
  if (who.length === 0 || days.length === 0) return [];
  const busy = await busyOn(c.ports, who.map((s) => s.calendarId), c.now, (days[days.length - 1] as OpenDay).closesAt);
  if (busy === null) return null;
  return days.map((day) => {
    const starts = new Set<number>();
    for (const s of who) {
      for (const t of freeStarts({ day, minutes, stepMinutes: c.config.slotStepMinutes, now: c.now, minLeadMinutes: c.config.minLeadMinutes, busy: busy.get(s.calendarId) ?? [] })) {
        starts.add(t.getTime());
      }
    }
    return { day, starts: [...starts].sort((a, b) => a - b).map((ms) => new Date(ms)) };
  });
}

/** Minutes after the tenant's local midnight. */
function minuteOfDay(at: Date, timezone: string): number {
  const [h, m] = tenantClock(at, timezone).time.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

const hhmm = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

/** How many times are offered around the one the customer asked for. */
const NEAREST = 6;

// ---------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------

function ask(step: Step, body: string, offers: Offer[], data: Record<string, unknown>): Reply {
  return { step, body, offers, data: { ...data, offers, missed: false }, close: null };
}

function unavailableReply(c: Ctx, data: Record<string, unknown>): Reply {
  const url = c.facts.bookingUrl;
  return {
    step: 'stylist', offers: [], data, close: 'unavailable',
    body: url === null ? '' : say(c.ports.wording, 'booking_unavailable', { booking_url: url }),
  };
}

/**
 * The first answer. A day or time the first message already named («маргааш 14 цагт цаг
 * авъя») is kept and checked once the stylist is known. Weekday names are not read here: in a
 * first message «Баасан» is as likely the customer's name.
 */
function firstQuestion(c: Ctx): Reply {
  const local = tenantClock(c.now, c.facts.timezone);
  const want = parseWhen(c.input.respelled ?? c.input.text, { date: local.date, weekday: local.weekday }, { weekdays: false });
  const base: Record<string, unknown> = want === null ? {} : { want };
  return c.config.genderRule ? whoQuestion(c, base) : serviceQuestion(c, base);
}

/** The children's services someone can serve under the gender rule. */
function childServicesOffered(config: BookingConfig): BookingConfig['childServices'] {
  return config.childServices.filter((s) => config.stylists.some((x) => x.gender === s.gender));
}

/**
 * «Хэнд зориулж цаг авах вэ?», first, under the tenant's gender rule: a woman books a woman
 * stylist, a man a man, and «Хүүхэд» leads to the children's services (each says who serves it).
 * Only choices someone can serve are offered.
 */
function whoQuestion(c: Ctx, data: Record<string, unknown>): Reply {
  const w = c.ports.wording;
  const offers: Offer[] = [];
  if (c.config.stylists.some((s) => s.gender === 'female')) offers.push({ t: say(w, 'booking_gender_female'), v: 'female' });
  if (c.config.stylists.some((s) => s.gender === 'male')) offers.push({ t: say(w, 'booking_gender_male'), v: 'male' });
  if (childServicesOffered(c.config).length > 0) offers.push({ t: say(w, 'booking_gender_child'), v: 'child' });
  return ask('gender', say(w, 'booking_ask_gender'), offers, data);
}

function serviceQuestion(c: Ctx, data: Record<string, unknown>): Reply {
  const w = c.ports.wording;
  const groups = c.config.serviceGroups;
  if (groups.length === 1) {
    const g = groups[0] as BookingConfig['serviceGroups'][number];
    return ask('service', say(w, 'booking_ask_service'), g.services.map((s) => ({ t: s.label, v: s.name })), { ...data, group: 0 });
  }
  return ask('group', say(w, 'booking_ask_service_group'), groups.map((g, i) => ({ t: g.label, v: String(i) })), data);
}

/** The service is chosen (and, under the rule, who it is for): the stylists who may serve it. */
function afterService(c: Ctx, data: Record<string, unknown>): Reply {
  const gender = (data['gender'] === 'male' || data['gender'] === 'female') ? data['gender'] as Gender : null;
  return ask('stylist', say(c.ports.wording, 'booking_ask_stylist'), stylistOffers(c.ports, c.config, c.config.genderRule ? gender : null), data);
}

function noTimes(c: Ctx, data: Record<string, unknown>): Reply {
  const gender = (data['gender'] === 'male' || data['gender'] === 'female') ? data['gender'] as Gender : null;
  return ask('stylist', say(c.ports.wording, 'booking_no_times'), stylistOffers(c.ports, c.config, gender), data);
}

/**
 * The stylist is chosen: ask when, with the days that still have a free time as buttons, unless
 * the customer already named a day or a time (then check it at once).
 */
async function afterStylist(c: Ctx, data: Record<string, unknown>): Promise<Reply> {
  const w = c.ports.wording;
  const want = data['want'] as Want | undefined;
  if (want !== undefined && want !== null) return offerTimes(c, data, want);
  const all = await freeByDay(c, data);
  if (all === null) return unavailableReply(c, data);
  const days = all.filter((d) => d.starts.length > 0) // ascii-safe: counts days, not characters
    .map((d) => ({ t: dayLabel(w, d.day.date, c.now, c.facts.timezone), v: d.day.date })).slice(0, 12);
  if (days.length === 0) return noTimes(c, data);
  return ask('when', say(w, 'booking_ask_when', { service: String(data['service']) }), days, data);
}

/**
 * The customer said when. Read the calendar and answer with the free times: the asked time
 * if it is free, else the nearest ones; the asked day if it has any, else the next day that
 * does. `lead` (a time just taken) replaces the free / not-free sentence.
 */
async function offerTimes(c: Ctx, data: Record<string, unknown>, want: Want, lead?: string): Promise<Reply> {
  const w = c.ports.wording;
  const tz = c.facts.timezone;
  const all = await freeByDay(c, data);
  if (all === null) return unavailableReply(c, data);
  const open = all.filter((d) => d.starts.length > 0);
  if (open.length === 0) return noTimes(c, data);

  const minutesOf = (d: OpenDay): [number, number] => {
    const midnight = d.opensAt.getTime() - minuteOfDay(d.opensAt, tz) * 60_000;
    return [(d.opensAt.getTime() - midnight) / 60_000, (d.closesAt.getTime() - midnight) / 60_000];
  };
  const target = (d: DayStarts): number | null => hourOn(want, ...minutesOf(d.day));
  const has = (d: DayStarts, minute: number | null) => minute !== null && d.starts.some((s) => minuteOfDay(s, tz) === minute);

  let pick: DayStarts;
  let dayFull: string | null = null;
  if (want.date !== null) {
    const named = all.find((d) => d.day.date === want.date);
    if (named !== undefined && named.starts.length > 0) pick = named;
    else {
      // Open that day and every start taken: full. Not among the open days at all (closed, a
      // closure, past, or beyond how far ahead the tenant books), or today with nothing left
      // that could still start: not bookable, never «full».
      const over = named !== undefined && freeStarts({
        day: named.day, minutes: Number(data['minutes']), stepMinutes: c.config.slotStepMinutes, now: c.now, minLeadMinutes: c.config.minLeadMinutes, busy: [],
      }).length === 0; // ascii-safe: counts starts
      dayFull = say(w, named !== undefined && !over ? 'booking_day_full' : 'booking_day_closed', { date: dayLabel(w, want.date, c.now, tz) });
      pick = open.find((d) => d.day.date > (want.date as string)) ?? open[0] as DayStarts;
    }
  } else if (want.hour !== null) {
    pick = open.find((d) => has(d, target(d))) ?? open[0] as DayStarts;
  } else {
    pick = open[0] as DayStarts;
  }

  const date = dayLabel(w, pick.day.date, c.now, tz);
  const t = target(pick);
  let starts = pick.starts.slice(0, 12);
  if (t !== null) {
    starts = [...pick.starts]
      .sort((a, b) => Math.abs(minuteOfDay(a, tz) - t) - Math.abs(minuteOfDay(b, tz) - t) || a.getTime() - b.getTime())
      .slice(0, NEAREST).sort((a, b) => a.getTime() - b.getTime());
  }
  // «14:00 is taken» only of a start the salon could ever offer: «12:30» on an hourly step, or
  // 7:00 before opening, is not taken, it is just not a time; the times nearest it are offered.
  const [opens, closes] = minutesOf(pick.day);
  const slot = t !== null && t >= opens && (t - opens) % c.config.slotStepMinutes === 0 && t + Number(data['minutes']) <= closes;
  let body: string;
  if (lead !== undefined || dayFull !== null || t === null || !slot) {
    body = [lead, dayFull, say(w, 'booking_ask_time', { date })].filter((x): x is string => x !== undefined && x !== null).join('\n');
  } else if (has(pick, t)) {
    body = say(w, 'booking_time_free', { date, time: hhmm(t) });
  } else {
    body = say(w, 'booking_time_not_free', { date, time: hhmm(t) });
  }
  return ask('time', body, starts.map((ms) => ({ t: timeLabel(ms, tz), v: ms.toISOString() })),
    { ...data, date: pick.day.date, want: { ...want, date: pick.day.date } });
}

/** Where a taken time sends the customer back to: that day, nearest to the time they had. */
function wantAround(data: Record<string, unknown>, tz: string): Want {
  const start = new Date(String(data['start']));
  const [h, m] = tenantClock(start, tz).time.split(':').map(Number) as [number, number];
  return { date: String(data['date']), hour: h, minute: m, afternoon: false };
}

/** The summary before the hold: what, who, when, how much, Tara's terms, «Зөвшөөрч, захиалах». */
function confirmQuestion(c: Ctx, session: Session, data: Record<string, unknown>): Reply | null {
  const w = c.ports.wording;
  const who = candidates(c.config, data);
  const first = who[0];
  const level = first === undefined ? undefined : c.config.levels.find((l) => l.key === first.level);
  const deposit = first === undefined ? null : depositFor(c.config, first.level, session.isTest);
  if (first === undefined || level === undefined || deposit === null) return null;
  const stylist = String(data['stylist']).startsWith('s:') ? stylistLabel(first.label, level.label) : say(w, 'booking_any_of_level', { level: level.label });
  const start = new Date(String(data['start']));
  return ask('agree', say(w, 'booking_ask_agreement', {
    service: String(data['service']), stylist,
    date: dayLabel(w, tenantClock(start, c.facts.timezone).date, c.now, c.facts.timezone), time: timeLabel(start, c.facts.timezone),
    amount: formatMnt(deposit), agreement: c.config.agreementText,
  }), [{ t: say(w, 'booking_agree'), v: 'yes' }], data);
}

/**
 * The customer agreed. Hold the time (database, then the calendar, then a second look), make
 * the QPay invoice, and answer with the pay button. Any stylist of the chosen level may take it.
 */
async function holdAndInvoice(c: Ctx, session: Session, data: Record<string, unknown>): Promise<Reply> {
  const { ports, config, facts } = c;
  const w = ports.wording;
  const start = new Date(String(data['start']));
  const minutes = Number(data['minutes']);
  const end = new Date(start.getTime() + minutes * 60_000);
  // The tenant's gender rule asked; without the rule nothing is recorded, never a guess.
  const gender = !config.genderRule ? null : data['gender'] === 'male' ? 'male' as const : data['gender'] === 'female' ? 'female' as const : null;

  /**
   * Put a database hold into the stylist's calendar (unless it is there already: a redelivered
   * message reuses its hold), then look again. `clash`: the website or a person wrote into the
   * time first, so the hold is given back. `fail`: the calendar cannot be used now.
   */
  const place = async (h: Hold): Promise<'ok' | 'clash' | 'fail'> => {
    const id = eventIdForHold(h.id);
    if (h.calendarState !== 'held') {
      const put = await ports.calendar.insert(h.calendarId, { id, ...bookingEvent(h, facts, 'hold', []) });
      if (!put.ok && put.outcome !== 'exists') {
        await endHold(ports.db, h.id, 'released', `calendar refused the hold: ${put.detail}`);
        return 'fail';
      }
      const marked2 = await setCalendarState(ports.db, h.id, id, 'held');
      if (!marked2.ok) ports.log('error', 'booking_calendar_state_failed', { holdId: h.id, detail: marked2.detail });
      h.calendarState = 'held';
      h.calendarEventId = id;
    }
    const ev = await ports.calendar.events(h.calendarId, h.startsAt, h.endsAt, facts.timezone);
    if (!ev.ok) {
      await expireHold(ports, h.id, 'released', 'calendar unreadable after the hold');
      return 'fail';
    }
    const clash = ev.events.some((e) => e.blocks && e.id !== id && e.start.getTime() < h.endsAt.getTime() && h.startsAt.getTime() < e.end.getTime());
    if (clash) {
      await expireHold(ports, h.id, 'released', 'the calendar had another booking in this time');
      return 'clash';
    }
    return 'ok';
  };

  let hold: Hold | null = null;
  // A redelivery of this very message: the session already holds a time. Pick it up, and make
  // sure the calendar shows it (the first attempt may have died before writing it there).
  const prior = await sessionHold(ports.db, session.id);
  if (!prior.ok) return unavailableReply(c, data);
  if (prior.hold !== null && prior.hold.state === 'held') {
    const placed = await place(prior.hold);
    if (placed === 'fail') return unavailableReply(c, data);
    if (placed === 'ok') hold = prior.hold;
  }

  // A time that has started (or is inside the lead time) since it was offered is not taken.
  if (hold === null && start.getTime() < c.now.getTime() + config.minLeadMinutes * 60_000) {
    return offerTimes(c, data, wantAround(data, facts.timezone), say(w, 'booking_slot_taken'));
  }

  if (hold === null) {
    for (const s of candidates(config, data)) {
      const level = config.levels.find((l) => l.key === s.level);
      const deposit = depositFor(config, s.level, session.isTest);
      if (level === undefined || deposit === null) continue;
      const busy = await busyOn(ports, [s.calendarId], start, end);
      if (busy === null) return unavailableReply(c, data);
      if (!isFree(start, minutes, busy.get(s.calendarId) ?? [])) continue;
      const take = () => acquireHold(ports.db, {
        tenantId: session.tenantId, sessionId: session.id, expiresAt: new Date(c.now.getTime() + config.holdMinutes * 60_000),
        hold: {
          calendarId: s.calendarId, staffName: s.label, level: level.label, service: String(data['service']), minutes,
          startsAt: start, endsAt: end, depositMnt: deposit, customerName: String(data['name']), customerPhone: String(data['phone']),
          gender, agreedAt: c.now, agreementText: config.agreementText,
        },
      });
      let got = await take();
      if (!got.ok) return unavailableReply(c, data);
      if (got.acquired.outcome === 'customer_has_hold') {
        // One hold per customer: the new QR replaces the time they held in an earlier booking
        // chat. Released the usual way (QPay asked first: a payment on it books it instead), then
        // the new time is taken.
        const old = await expireHold(ports, got.acquired.holdId, 'released', 'replaced by the customer\'s new QR');
        if (old === 'unavailable' || old === 'not_due') return unavailableReply(c, data);
        got = await take();
        if (!got.ok || got.acquired.outcome === 'customer_has_hold') return unavailableReply(c, data);
      }
      if (got.acquired.outcome === 'taken') continue;
      if (got.acquired.outcome === 'no_session') return unavailableReply(c, data);
      let candidate: Hold;
      if (got.acquired.outcome === 'session_has_hold') {
        const h = await readHold(ports.db, got.acquired.holdId);
        if (!h.ok || h.hold === null) return unavailableReply(c, data);
        candidate = h.hold;
      } else {
        candidate = got.acquired.hold;
      }
      const placed = await place(candidate);
      if (placed === 'fail') return unavailableReply(c, data);
      if (placed === 'clash') continue;
      hold = candidate;
      break;
    }
  }

  if (hold === null) {
    // Every stylist that could have taken it is taken: say so, offer the times left nearest it.
    return offerTimes(c, data, wantAround(data, facts.timezone), say(w, 'booking_slot_taken'));
  }

  const inv = await currentInvoice(ports, hold, config);
  if (!inv.ok) {
    ports.log('error', 'booking_invoice_failed', { holdId: hold.id, detail: inv.detail });
    await expireHold(ports, hold.id, 'released', `QPay invoice not made: ${inv.detail}`);
    return unavailableReply(c, data);
  }
  // The end of the five minutes, on time: the time is released and the customer told then.
  try {
    // Bounded: a slow QStash never delays the customer's QR (the minute sweep is the fallback).
    if (ports.scheduleSweep !== undefined) {
      await Promise.race([ports.scheduleSweep(hold.expiresAt, hold.id), new Promise<void>((r) => { setTimeout(r, 3_000).unref?.(); })]);
    }
  } catch (e) {
    ports.log('error', 'booking_sweep_not_scheduled', { holdId: hold.id, error: e instanceof Error ? e.message : 'error' });
  }
  const date = tenantClock(hold.startsAt, facts.timezone).date;
  const body = say(w, 'booking_pay', {
    service: hold.service,
    stylist: stylistLabel(hold.staffName, hold.level),
    date: dayLabel(w, date, c.now, facts.timezone),
    time: timeLabel(hold.startsAt, facts.timezone),
    amount: formatMnt(hold.depositMnt),
    minutes: String(config.holdMinutes),
    pay_link: payUrl(ports.origin, ports.secret, hold.id),
  });
  return {
    step: 'pay', body, offers: [], data: { ...data, holdId: hold.id, offers: [], missed: false }, close: null,
    linkButtonTitle: say(w, 'billing_pay_button'),
  };
}

/** The answer to one message, given the session it arrived in. */
async function next(c: Ctx, session: Session): Promise<Reply | 'not_mine'> {
  const w = c.ports.wording;
  const data = { ...session.data };
  const step = session.step as Step;
  const choice = picked(session, c.input, say(w, 'booking_cancel'));

  if (choice === 'cancel') {
    return { step, body: say(w, 'booking_cancelled'), offers: [], data, close: 'cancelled' };
  }
  if (step === 'rebook') return rebookTurn(c, data, choice);

  // An old button. A day: that day's times. A time: that time if it is still free (it is what
  // the customer saw and tapped), else «taken» with the nearest free times on that day.
  if (choice !== null && 'stale' in choice) {
    if (step === 'when' && /^\d{4}-\d{2}-\d{2}$/u.test(choice.stale)) {
      return offerTimes(c, data, { date: choice.stale, hour: null, minute: 0, afternoon: false });
    }
    const at = new Date(choice.stale);
    if (step === 'time' && !Number.isNaN(at.getTime())) {
      const date = tenantClock(at, c.facts.timezone).date;
      const around = wantAround({ start: at.toISOString(), date }, c.facts.timezone);
      const fresh = await offerTimes(c, { ...data, date }, around);
      if (fresh.step === 'time' && fresh.offers.some((o) => o.v === at.toISOString())) {
        return ask('name', say(w, 'booking_ask_name'), [], { ...fresh.data, start: at.toISOString() });
      }
      if (fresh.step !== 'time') return fresh;
      return offerTimes(c, { ...data, date }, around, say(w, 'booking_slot_taken'));
    }
    if (data['missed'] === true) return 'not_mine';
    const offers = Array.isArray(data['offers']) ? (data['offers'] as Offer[]) : [];
    return { step, body: say(w, 'booking_pick_from_list'), offers, data: { ...data, missed: true }, close: null };
  }

  // Free-text steps. Anything that is not a name or a phone is asked again ONCE, then the flow
  // steps aside so Дали answers it: a question is never stored as a name, never trapped.
  // A button (an old one, another step's) is never a name or a phone.
  const tapped = c.input.quickReplyPayload?.startsWith('bk:') === true;
  if (step === 'name') {
    const name = !tapped && looksLikeName(c.input.text) ? typedName(c.input.text) : null;
    if (name !== null) return ask('phone', say(w, 'booking_ask_phone'), [], { ...data, name });
    if (data['missed'] === true) return 'not_mine';
    return { step, body: say(w, 'booking_ask_name'), offers: [], data: { ...data, missed: true }, close: null };
  }
  if (step === 'phone') {
    const phone = tapped ? null : typedPhone(c.input.text);
    if (phone !== null) return confirmQuestion(c, session, { ...data, phone }) ?? unavailableReply(c, data);
    if (data['missed'] === true) return 'not_mine';
    return { step, body: say(w, 'booking_phone_invalid'), offers: [], data: { ...data, missed: true }, close: null };
  }

  // When, and the offered times: a typed day or time («маргааш 2 цагт», «16 цаг», «нөгөөдөр»)
  // is checked against the calendar. At the times, a day left out means the day on offer.
  if (choice === null && (step === 'when' || step === 'time')) {
    const local = tenantClock(c.now, c.facts.timezone);
    const typed = parseWhen(c.input.respelled ?? c.input.text, { date: local.date, weekday: local.weekday })
      ?? (c.input.respelled === null ? null : parseWhen(c.input.text, { date: local.date, weekday: local.weekday }));
    // Naming the day already on offer with no hour adds nothing: a miss. A question with no hour
    // («Маргааш болох уу?») gets that day's times but still counts as a miss, so a second
    // non-answer lets the ordinary Дали answer. «Маргааш 2 цагт болох уу?» names an hour: it is
    // the customer asking for that time.
    const question = /[?？]\s*$/u.test(c.input.text) || /(?<![\p{L}\p{N}])(?:уу|үү|юу|юү|вэ|бэ)[\s.!]*$/u.test(fold(c.input.text));
    const noHour = typed !== null && typed.hour === null;
    const sameDay = step === 'time' && noHour && typed?.date === data['date'];
    if (typed !== null && !sameDay && !(question && noHour && data['missed'] === true)) {
      const offer = await offerTimes(c, data, step === 'time' && typed.date === null ? { ...typed, date: String(data['date']) } : typed);
      // «Маргааш болох уу?» is answered with tomorrow's times, but as a miss: if the next message
      // is not a pick either, the flow steps aside, so a question is never answered by times for ever.
      return question && noHour && offer.step === 'time' && offer.close === null
        ? { ...offer, data: { ...offer.data, missed: true } } : offer;
    }
  }

  if (choice === null) {
    if (data['missed'] === true) return 'not_mine';
    const offers = Array.isArray(data['offers']) ? (data['offers'] as Offer[]) : [];
    const again = step === 'when' ? say(w, 'booking_when_again') : say(w, 'booking_pick_from_list');
    return { step, body: again, offers, data: { ...data, missed: true }, close: null };
  }

  switch (step) {
    case 'group': {
      const g = c.config.serviceGroups[Number(choice.v)];
      if (g === undefined) return 'not_mine';
      return ask('service', say(w, 'booking_ask_service'), g.services.map((s) => ({ t: s.label, v: s.name })), { ...data, group: Number(choice.v) });
    }
    case 'service': {
      // A children's service says who serves it: a girl's a woman stylist, a boy's a man.
      const child = data['child'] === true ? childServicesOffered(c.config).find((x) => x.name === choice.v) : undefined;
      const s = child ?? (data['child'] === true ? undefined : allServices(c.config).find((x) => x.name === choice.v));
      if (s === undefined) return 'not_mine';
      return afterService(c, { ...data, service: s.name, minutes: s.minutes, ...(child === undefined ? {} : { gender: child.gender }) });
    }
    case 'gender': {
      if (choice.v === 'child') {
        const kids = childServicesOffered(c.config);
        if (kids.length === 0) return 'not_mine';
        return ask('service', say(w, 'booking_ask_service'), kids.map((s) => ({ t: s.label, v: s.name })), { ...data, child: true });
      }
      return serviceQuestion(c, { ...data, gender: choice.v === 'male' ? 'male' : 'female' });
    }
    case 'stylist':
      return afterStylist(c, { ...data, stylist: choice.v });
    case 'when':
      return offerTimes(c, data, { date: choice.v, hour: null, minute: 0, afternoon: false });
    case 'time':
      return ask('name', say(w, 'booking_ask_name'), [], { ...data, start: choice.v });
    case 'agree':
      return holdAndInvoice(c, session, data);
    default:
      return 'not_mine';
  }
}

// ---------------------------------------------------------------------------
// A paid deposit whose time was taken: the nearest free times, booked on the same money
// ---------------------------------------------------------------------------

/**
 * The customer's deposit arrived after its time was gone (late, and someone else has it). Дали
 * says so and offers the nearest free times for the same service and level (so the same
 * deposit); a time the customer taps is booked on that deposit (`rebookTo`). The founder is paged
 * either way (`engine.ts`), to refund if the customer picks nothing. `no_offer`: nothing free,
 * or the customer is in another booking chat: the plain paid-unbooked line is sent instead.
 */
export async function offerRebook(ports: BookingPorts, hold: Hold, facts: TenantFacts, config: BookingConfig, round: string):
  Promise<'sent' | 'already' | 'not_delivering' | 'failed' | 'no_offer'> {
  if (hold.notifiedAt !== null) return 'already';
  // Past the half hour the founder was given (a retry after failed sends): nothing more is offered.
  if (hold.endedAt !== null && ports.now().getTime() > hold.endedAt.getTime() + REBOOK_OFFER_MINUTES * 60_000) return 'no_offer';
  const level = config.levels.find((l) => l.label === hold.level);
  if (level === undefined || hold.conversationId === null) return 'no_offer';
  const now = ports.now();
  const tz = facts.timezone;
  const local = tenantClock(now, tz);
  const hc = await readHoursAndClosures(ports.db, hold.tenantId, local.date);
  // An error is not «nothing free»: refused, and retried by the sweep.
  if (!hc.ok) return 'failed';
  const c: Ctx = {
    ports, config, facts, now,
    input: {
      tenantId: hold.tenantId, channelId: hold.channelId, conversationId: hold.conversationId, psid: hold.psid,
      mid: '', text: '', respelled: null, hours: hc.hours, closures: hc.closures,
    },
  };
  const base: Record<string, unknown> = {
    service: hold.service, minutes: hold.minutes, gender: hold.gender, rebookLevel: hold.level,
    name: hold.customerName, phone: hold.customerPhone, rebookHold: hold.id, preferCalendar: hold.calendarId,
  };
  const heldDate = tenantClock(hold.startsAt, tz).date;
  const [h, m] = tenantClock(hold.startsAt, tz).time.split(':').map(Number) as [number, number];
  // Around the time they paid for: that day (or today, if it has passed), that hour as it was.
  const want: Want = { date: heldDate < local.date ? local.date : heldDate, hour: h, minute: m, afternoon: false, morning: true };
  const lead = say(ports.wording, 'booking_paid_unbooked_offer', { date: dayLabel(ports.wording, heldDate, now, tz), time: timeLabel(hold.startsAt, tz) });
  // The same stylist first («16:00 is taken» next to a «16:00» button for someone else reads
  // wrong); any stylist of the same level (the same deposit) only when she has nothing free.
  const usable = (r: Reply) => r.step === 'time' && r.close === null && r.offers.length > 0;
  let offer = await offerTimes(c, { ...base, stylist: `s:${hold.calendarId}` }, want, lead);
  if (!usable(offer)) offer = await offerTimes(c, { ...base, stylist: `any:${level.key}` }, want, lead);
  if (!usable(offer)) return 'no_offer';
  // The chat is opened only now that there is something to offer: never a session left at
  // `start` with nothing in it.
  const open = await readOpenSession(ports.db, hold.tenantId, hold.conversationId);
  if (!open.ok) return 'failed';
  let session = open.session;
  if (session !== null && session.id !== hold.sessionId && session.step !== 'rebook') return 'no_offer';
  let openedHere = false;
  if (session === null) {
    const opened = await openSession(ports.db, {
      tenantId: hold.tenantId, conversationId: hold.conversationId, channelId: hold.channelId, psid: hold.psid,
      isTest: hold.isTest, step: 'start', data: {},
    });
    if (!opened.ok) return 'failed';
    session = opened.session;
    openedHere = opened.created;
  }
  const failed = async (): Promise<'failed'> => {
    if (openedHere) await closeSessionRow(ports.db, (session as Session).id, 'rebook_offer_failed', now, 'start');
    return 'failed';
  };
  const applied = await applyTurn(ports.db, {
    tenantId: hold.tenantId, session, dedupKey: `booking:${hold.id}:paid_unbooked_offer:${round}`, step: 'rebook',
    data: { ...offer.data, offers: offer.offers, missed: false, offerStep: 'rebook' }, closeReason: null,
    body: marked(ports.wording, hold.isTest, offer.body),
  });
  if (!applied.ok || applied.turn.outcome === 'stale' || applied.turn.outboundId === null) return failed();
  const sent = await deliverDrafted(ports, { tenantId: hold.tenantId, channelId: hold.channelId, psid: hold.psid }, applied.turn.outboundId,
    { holdId: hold.id, event: 'paid_unbooked_offer' },
    { quickReplies: quickReplies('rebook', offer.offers, say(ports.wording, 'booking_cancel')) });
  // A channel that does not deliver: the founder is told the deposit is theirs, so no offer may
  // stay open behind that (a later tap would book a deposit they may have refunded).
  if (sent === 'not_delivering') {
    const r = await closeSessionRow(ports.db, (session as Session).id, 'rebook_not_delivering', now, 'rebook');
    if (!r.ok) {
      // Not closed: never report «yours to refund» with the offer still open. Retried next minute.
      ports.log('error', 'booking_session_close_failed', { holdId: hold.id, detail: r.detail });
      return 'failed';
    }
  }
  return sent;
}

/** A message in the rebook chat: a time tapped (or typed), another day asked, or nothing of the sort. */
async function rebookTurn(c: Ctx, data: Record<string, unknown>, choice: Offer | 'cancel' | { stale: string } | null): Promise<Reply | 'not_mine'> {
  const w = c.ports.wording;
  const asRebook = (r: Reply): Reply => (r.step === 'time' ? { ...r, step: 'rebook' } : r);
  if (choice !== null && choice !== 'cancel' && !('stale' in choice)) return rebookTo(c, data, new Date(choice.v));
  if (choice !== null && choice !== 'cancel' && 'stale' in choice && !Number.isNaN(new Date(choice.stale).getTime())) {
    return rebookTo(c, data, new Date(choice.stale));
  }
  const local = tenantClock(c.now, c.facts.timezone);
  const typed = parseWhen(c.input.respelled ?? c.input.text, { date: local.date, weekday: local.weekday });
  if (typed !== null && !(typed.hour === null && typed.date === data['date'])) {
    const r = asRebook(await offerTimes(c, data, typed.date === null ? { ...typed, date: String(data['date']) } : typed));
    return r.step === 'rebook' && r.close === null ? r : 'not_mine';
  }
  if (data['missed'] === true) return 'not_mine';
  const offers = Array.isArray(data['offers']) ? (data['offers'] as Offer[]) : [];
  return { step: 'rebook', body: say(w, 'booking_pick_from_list'), offers, data: { ...data, missed: true }, close: null };
}

/**
 * Book the paid deposit at `start`: the original stylist first, then any other of the same level.
 * The hold moves (`booking_rebook_hold`), then the ordinary booking path writes the calendar and
 * sends the confirmation. A time gone meanwhile: «taken», and the nearest free times again.
 */
async function rebookTo(c: Ctx, data: Record<string, unknown>, start: Date): Promise<Reply | 'not_mine'> {
  const { ports, config } = c;
  const w = ports.wording;
  const holdId = String(data['rebookHold']);
  const minutes = Number(data['minutes']);
  const end = new Date(start.getTime() + minutes * 60_000);
  const tz = c.facts.timezone;
  const again = async (): Promise<Reply | 'not_mine'> => {
    const r = await offerTimes(c, data, wantAround({ start: start.toISOString(), date: tenantClock(start, tz).date }, tz), say(w, 'booking_slot_taken'));
    return r.step === 'time' && r.close === null ? { ...r, step: 'rebook' } : 'not_mine';
  };
  if (start.getTime() < c.now.getTime() + config.minLeadMinutes * 60_000) return again();
  const prefer = String(data['preferCalendar'] ?? '');
  const order = [...candidates(config, data)].sort((a, b) => Number(b.calendarId === prefer) - Number(a.calendarId === prefer));
  for (const s of order) {
    const busy = await busyOn(ports, [s.calendarId], start, end);
    if (busy === null) return 'not_mine';
    if (!isFree(start, minutes, busy.get(s.calendarId) ?? [])) continue;
    // The stylist's own level, compared in SQL with the deposit's: a stylist moved to another
    // level since is never booked on the old deposit.
    const sLevel = config.levels.find((l) => l.key === s.level)?.label ?? '';
    const move = () => rebookHold(ports.db, { holdId, calendarId: s.calendarId, staffName: s.label, level: sLevel, startsAt: start, endsAt: end });
    let moved = await move();
    if (moved.ok && moved.outcome === 'calendar_busy') {
      // The old time's busy event is still in a calendar: removed first, so nothing is left behind.
      const h = await readHold(ports.db, holdId);
      if (h.ok && h.hold !== null) await removeOurEvent(ports, h.hold);
      moved = await move();
    }
    if (!moved.ok) {
      ports.log('error', 'booking_rebook_failed', { holdId, detail: moved.detail });
      return 'not_mine';
    }
    // Already booked or ended meanwhile (another tap, a person): nothing more to say here.
    if (moved.outcome === 'not_paid_unbooked') return { step: 'rebook', body: '', offers: [], data, close: 'rebooked' };
    // Past the half hour the founder was told: the deposit is theirs to refund or book now.
    if (moved.outcome === 'offer_over' || moved.outcome === 'calendar_busy') {
      return { step: 'rebook', body: say(w, 'booking_paid_unbooked'), offers: [], data, close: moved.outcome };
    }
    if (moved.outcome !== 'rebooked') continue;
    const settled = await settleHold(ports, holdId);
    // Booked: the confirmation went out by itself. Pending: the sweep writes it and confirms.
    if (settled === 'booked' || settled === 'already_booked' || settled === 'calendar_pending') {
      return { step: 'rebook', body: '', offers: [], data, close: 'rebooked' };
    }
    // The calendar had someone at that time after all (the hold is paid-unbooked again): try on.
  }
  return again();
}

/** A message while a payment is pending: settle, and let Дали answer anything else. */
/**
 * A message while a payment is pending. Settle first (it may be the message the payment raced).
 * Only a payment settled BY this message, or a hold this message let expire, is answered by the
 * push that went out; everything else goes to the ordinary Дали, and a session whose hold is
 * over is closed so the next message never comes here again.
 */
async function duringPay(c: Ctx, session: Session): Promise<TurnResult> {
  const held = await sessionHold(c.ports.db, session.id);
  if (!held.ok) return { handled: false, reason: 'hold_unreadable' };
  const hold = held.hold;
  const over = async (reason: string): Promise<TurnResult> => {
    // Only while still paying: a paid deposit whose time was taken has just been moved to the
    // rebook offer in this very session, which must stay open for the customer's tap.
    const r = await closeSessionRow(c.ports.db, session.id, reason, c.now, 'pay');
    if (!r.ok) c.ports.log('error', 'booking_session_close_failed', { sessionId: session.id, detail: r.detail });
    return { handled: false, reason: `booking over (${reason})` };
  };
  if (hold === null) return over('no_hold');
  if (hold.state !== 'held' && hold.state !== 'paid') {
    // Booked, ended or paid-unbooked earlier: make sure the customer was told, then step aside.
    // settleHold repeats the confirmation or the paid-unbooked alert and push (each keyed, so
    // never twice) in case the call that got here died before telling anyone.
    if (hold.state === 'booked' || hold.state === 'paid_unbooked') await settleHold(c.ports, hold.id);
    return over(`hold_${hold.state}`);
  }
  const cancel = picked(session, c.input, say(c.ports.wording, 'booking_cancel')) === 'cancel';
  if (cancel && hold.state === 'held') {
    const r = await expireHold(c.ports, hold.id, 'released', 'the customer cancelled');
    if (r === 'released') {
      return draft(c, session, { step: 'pay', body: say(c.ports.wording, 'booking_cancelled'), offers: [], data: session.data, close: 'cancelled' });
    }
    // Paid meanwhile: the confirmation went out and answers it. QPay unreadable: the hold is
    // kept (money first) and Дали answers, rather than silence.
    return r === 'paid' ? { handled: true, outboundId: null, quickReplies: [], detail: 'cancel after payment' }
      : { handled: false, reason: `cancel not done (${r})` };
  }
  const r = await settleHold(c.ports, hold.id);
  if (r === 'booked') return { handled: true, outboundId: null, quickReplies: [], detail: 'settled: booked' };
  // Paid, but the time was taken: the offer of other times has just gone out and answers it.
  if (r === 'paid_unbooked') {
    await over('settled_paid_unbooked');
    return { handled: true, outboundId: null, quickReplies: [], detail: 'settled: paid, time taken, offer sent' };
  }
  if (r === 'already_booked' || r === 'ended') return over(`settled_${r}`);
  if (r === 'unpaid' && c.now.getTime() >= hold.expiresAt.getTime()) {
    const e = await expireHold(c.ports, hold.id);
    if (e === 'expired') return { handled: true, outboundId: null, quickReplies: [], detail: 'expired on message' };
  }
  return { handled: false, reason: `payment pending (${r})` };
}

async function draft(c: Ctx, session: Session, reply: Reply): Promise<TurnResult> {
  const cancelTitle = say(c.ports.wording, 'booking_cancel');
  const body = reply.body === '' ? null : marked(c.ports.wording, session.isTest, reply.body);
  const applied = await applyTurn(c.ports.db, {
    tenantId: session.tenantId, session, dedupKey: replyDedupKey(c.input.mid), step: reply.step,
    data: { ...reply.data, offerStep: reply.step }, closeReason: reply.close, body,
  });
  if (!applied.ok) {
    c.ports.log('error', 'booking_turn_failed', { sessionId: session.id, detail: applied.detail });
    return { handled: false, reason: 'turn_failed' };
  }
  if (applied.turn.outcome === 'stale') return { handled: false, reason: 'stale' };
  const qr = reply.close === null && reply.step !== 'pay' ? quickReplies(reply.step, reply.offers, cancelTitle)
    : reply.step === 'pay' && reply.close === null ? [{ title: cancelTitle, payload: CANCEL }] : [];
  return {
    handled: true,
    outboundId: applied.turn.outboundId,
    quickReplies: qr,
    ...(reply.linkButtonTitle === undefined ? {} : { linkButtonTitle: reply.linkButtonTitle }),
    detail: `${session.step} -> ${reply.step}${reply.close === null ? '' : ` (closed: ${reply.close})`}`,
  };
}

/**
 * The reception worker's question: is this message the booking flow's? `handled: false` means
 * the ordinary reply path answers it, exactly as it would with the flow switched off.
 */
export async function bookingTurn(ports: BookingPorts, input: TurnInput): Promise<TurnResult> {
  if (bookingEnvMode() === 'off') return { handled: false, reason: 'env_off' };
  const missing = missingBlocks(ports.wording);
  if (missing.length > 0) return { handled: false, reason: `unsigned: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''}` };
  const cfg = await readConfig(ports.db, input.tenantId);
  if (!cfg.ok) {
    ports.log('error', 'booking_config_unreadable', { tenantId: input.tenantId, detail: cfg.detail });
    return { handled: false, reason: 'config_unreadable' };
  }
  if (!cfg.present) return { handled: false, reason: 'no_config' };
  if (!cfg.valid) {
    ports.log('warn', 'booking_config_invalid', { tenantId: input.tenantId, detail: cfg.detail });
    return { handled: false, reason: 'config_invalid' };
  }
  const who = customerMode(bookingEnvMode(), cfg.mode, cfg.config, input.psid);
  if (!who.on) return { handled: false, reason: 'not_for_this_customer' };
  const facts = await readTenantFacts(ports.db, input.tenantId);
  if (!facts.ok) {
    ports.log('error', 'booking_facts_unreadable', { tenantId: input.tenantId, detail: facts.detail });
    return { handled: false, reason: 'facts_unreadable' };
  }
  const c: Ctx = { ports, config: cfg.config, facts: facts.facts, input, now: ports.now() };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const open = await readOpenSession(ports.db, input.tenantId, input.conversationId);
    if (!open.ok) return { handled: false, reason: 'session_unreadable' };
    let session = open.session;

    if (session !== null && session.step !== 'pay' && c.now.getTime() - session.updatedAt.getTime() > SESSION_IDLE_MINUTES * 60_000) {
      const closed = await applyTurn(ports.db, {
        tenantId: input.tenantId, session, dedupKey: `booking-idle:${session.id}`, step: session.step, data: session.data, closeReason: 'idle', body: null,
      });
      if (!closed.ok) return { handled: false, reason: 'session_close_failed' };
      session = null;
    }

    const subject = { text: input.text, attachments: [], respelled: input.respelled };
    const startsAgain = input.quickReplyPayload === START
      || (input.quickReplyPayload?.startsWith('bk:') !== true && entryFires(cfg.config, subject));

    // A new booking asked for while a QR is out: the paying chat is closed and a new one starts.
    // The held time stays held until it ends or the new QR replaces it (one hold per customer).
    // «Цаг сонгох» tapped in any open chat starts again too: a button is never read as a name.
    if (session !== null && ((session.step === 'pay' && startsAgain) || input.quickReplyPayload === START)) {
      const r = await closeSessionRow(ports.db, session.id, 'started_again', c.now);
      if (!r.ok) return { handled: false, reason: 'session_close_failed' };
      session = null;
    }

    if (session === null) {
      if (!startsAgain) {
        return { handled: false, reason: input.quickReplyPayload?.startsWith('bk:') === true ? 'button_of_a_closed_booking' : 'not_a_booking_message' };
      }
      const opened = await openSession(ports.db, {
        tenantId: input.tenantId, conversationId: input.conversationId, channelId: input.channelId, psid: input.psid,
        isTest: who.isTest, step: 'start', data: {},
      });
      if (!opened.ok) return { handled: false, reason: 'session_open_failed' };
      if (!opened.created) continue;
      const r = await draft(c, opened.session, firstQuestion(c));
      if (!r.handled && r.reason === 'stale') continue;
      return r;
    }

    if (session.step === 'pay') return duringPay(c, session);
    const reply = await next(c, session);
    if (reply === 'not_mine') {
      // Asked once already: step aside, close quietly, and let Дали answer.
      const closed = await applyTurn(ports.db, {
        tenantId: input.tenantId, session, dedupKey: `booking-left:${session.id}`, step: session.step, data: session.data, closeReason: 'left', body: null,
      });
      if (!closed.ok) ports.log('error', 'booking_session_close_failed', { sessionId: session.id, detail: closed.detail });
      return { handled: false, reason: 'customer_left_the_flow' };
    }
    if (reply.body === '' && reply.close === 'unavailable') {
      // No booking link to point at: close and let Дали answer.
      await applyTurn(ports.db, {
        tenantId: input.tenantId, session, dedupKey: `booking-unavailable:${session.id}`, step: session.step, data: session.data, closeReason: 'unavailable', body: null,
      });
      return { handled: false, reason: 'unavailable_no_link' };
    }
    const r = await draft(c, session, reply);
    if (!r.handled && r.reason === 'stale') continue;
    return r;
  }
  return { handled: false, reason: 'stale' };
}

/**
 * The minute sweep's follow-up: a customer who was offered times and has said nothing for
 * `FOLLOW_UP_MINUTES` is asked once «Цаг захиалах уу?» with the times read fresh from the
 * calendar (some may have gone meanwhile). Once per booking chat, never after the chat idled
 * out, never for a customer the flow is not on for.
 *
 * Never over a person or over the customer: not while staff hold the thread (any `human`
 * control, whatever its cooldown: a nudge is worth less than talking over a receptionist), and
 * not once anything newer than the offer is in the conversation (a photo, a sticker, a message
 * the flow did not take, staff's own reply). Written through the same versioned turn as a reply,
 * and the session is read again just before sending, so a customer answering at the same moment
 * wins and the follow-up is refused, never sent late.
 */
export async function followUps(ports: BookingPorts, budgetMs = 30_000): Promise<{ sent: number; skipped: number; failed: number }> {
  const out = { sent: 0, skipped: 0, failed: 0 };
  if (bookingEnvMode() === 'off' || missingBlocks(ports.wording).length > 0) return out;
  const started = Date.now();
  const now = ports.now();
  const due = await sessionsToFollowUp(ports.db, now, FOLLOW_UP_MINUTES, SESSION_IDLE_MINUTES);
  if (!due.ok) {
    ports.log('error', 'booking_follow_up_unreadable', { detail: due.detail });
    out.failed += 1;
    return out;
  }
  for (const session of due.sessions) {
    // The rest wait for the next minute; a follow-up a minute late is still a follow-up. One
    // follow-up can take a calendar read and a send, so none starts without that much left.
    if (budgetMs - (Date.now() - started) < ONE_FOLLOW_UP_MS) break;
    try {
      const r = await followUp(ports, session, now);
      out[r] += 1;
    } catch (e) {
      out.failed += 1;
      ports.log('error', 'booking_follow_up_threw', { sessionId: session.id, error: e instanceof Error ? e.message : 'error' });
    }
  }
  return out;
}

async function followUp(ports: BookingPorts, session: Session, now: Date): Promise<'sent' | 'skipped' | 'failed'> {
  const fail = (what: string, detail: string): 'failed' => {
    ports.log('error', 'booking_follow_up_unreadable', { sessionId: session.id, what, detail });
    return 'failed';
  };
  // Decided not to follow this chat up: marked, so it is not looked at again every minute.
  const skip = async (why: string): Promise<'skipped'> => {
    ports.log('info', 'booking_follow_up_skipped', { sessionId: session.id, why });
    const m = await markFollowedUp(ports.db, session.id, now);
    if (!m.ok) ports.log('error', 'booking_follow_up_mark_failed', { sessionId: session.id, detail: m.detail });
    return 'skipped';
  };

  const cfg = await readConfig(ports.db, session.tenantId);
  if (!cfg.ok) return fail('config', cfg.detail);
  if (!cfg.present || !cfg.valid) return skip('no usable config');
  const who = customerMode(bookingEnvMode(), cfg.mode, cfg.config, session.psid);
  if (!who.on || who.isTest !== session.isTest) return skip('flow not on for this customer');

  const thread = await readThreadState(ports.db, { tenantId: session.tenantId, conversationId: session.conversationId });
  if (thread === 'unreadable') return fail('thread_control', 'conversation unreadable');
  if (thread.control === 'human') return skip('a person holds the thread');
  const moved = await conversationMovedOn(ports.db, session.tenantId, session.conversationId, session.updatedAt);
  if (!moved.ok) return fail('messages', moved.detail);
  if (moved.moved) return skip('the conversation moved on after the offer');

  const facts = await readTenantFacts(ports.db, session.tenantId);
  if (!facts.ok) return fail('facts', facts.detail);
  const local = tenantClock(now, facts.facts.timezone);
  if (String(session.data['date']) < local.date) return skip('the offered day has passed');
  const hc = await readHoursAndClosures(ports.db, session.tenantId, local.date);
  if (!hc.ok) return fail('hours', hc.detail);
  const c: Ctx = {
    ports, config: cfg.config, facts: facts.facts, now,
    input: {
      tenantId: session.tenantId, channelId: session.channelId, conversationId: session.conversationId, psid: session.psid,
      mid: '', text: '', respelled: null, hours: hc.hours, closures: hc.closures,
    },
  };
  const data = { ...session.data };
  const stored = data['want'] as Want | undefined;
  const want: Want = {
    date: String(data['date']), hour: stored?.hour ?? null, minute: stored?.minute ?? 0, afternoon: stored?.afternoon ?? false,
    ...(stored?.morning === true ? { morning: true } : {}),
  };
  const offer = await offerTimes(c, data, want);
  if (offer.close === 'unavailable') return fail('calendar', 'calendar unreadable');
  if (offer.step !== 'time' || offer.close !== null || offer.offers.length === 0) return skip('no time left to offer');

  const body = marked(ports.wording, session.isTest, `${say(ports.wording, 'booking_follow_up')}\n${offer.body}`);
  const applied = await applyTurn(ports.db, {
    tenantId: session.tenantId, session, dedupKey: `booking-followup:${session.id}`, step: 'time',
    data: { ...offer.data, offerStep: 'time' }, closeReason: null, body,
  });
  if (!applied.ok) return fail('turn', applied.detail);
  // The customer answered meanwhile: their turn won. Looked at again only if they go quiet on new times.
  if (applied.turn.outcome === 'stale') return 'skipped';
  // Drafted by an earlier run that stopped before marking: never sent now (its text named the
  // times of then, and the buttons would be today's).
  if (applied.turn.outcome === 'exists') {
    // Drafted by a run that stopped before marking: refused, so it is never sent and never read
    // back as a turn the customer received. A draft younger than two minutes may be another run
    // that is sending it right now (runs can overlap): left to that run.
    const created = await outboundCreatedAt(ports.db, session.tenantId, applied.turn.outboundId);
    if (!created.ok) return fail('outbound', created.detail);
    if (now.getTime() - created.at.getTime() < 2 * 60_000) return 'skipped';
    const r = await markRefused(ports.db, { id: applied.turn.outboundId, tenantId: session.tenantId, reason: 'booking_follow_up: drafted by an earlier run', from: ['draft', 'failed'] });
    if (!r.ok) ports.log('error', 'booking_follow_up_refuse_failed', { sessionId: session.id, detail: r.detail });
    return skip('already drafted once');
  }
  const marked2 = await markFollowedUp(ports.db, session.id, now);
  if (!marked2.ok) ports.log('error', 'booking_follow_up_mark_failed', { sessionId: session.id, detail: marked2.detail });
  const outboundId = applied.turn.outboundId;
  if (outboundId === null) return 'skipped';

  // Last look before sending: the customer may have answered in the moment since the draft.
  const refuse = async (why: string): Promise<'skipped'> => {
    const r = await markRefused(ports.db, { id: outboundId, tenantId: session.tenantId, reason: `booking_follow_up: ${why}`, from: ['draft', 'failed'] });
    if (!r.ok) ports.log('error', 'booking_follow_up_refuse_failed', { sessionId: session.id, detail: r.detail });
    return 'skipped';
  };
  const now2 = await readOpenSession(ports.db, session.tenantId, session.conversationId);
  if (!now2.ok) {
    await refuse('session unreadable before sending');
    return fail('session', now2.detail);
  }
  if (now2.session === null || now2.session.id !== session.id || now2.session.version !== session.version + 1) return refuse('the customer answered first');

  const sent = await deliverDrafted(ports, { tenantId: session.tenantId, channelId: session.channelId, psid: session.psid }, outboundId,
    { sessionId: session.id, event: 'follow_up' }, { quickReplies: quickReplies('time', offer.offers, say(ports.wording, 'booking_cancel')) });
  if (sent === 'sent' || sent === 'already') return sent === 'sent' ? 'sent' : 'skipped';
  // A channel that does not deliver (shadow) keeps the draft as its record, as every reply does.
  if (sent === 'not_delivering') return 'skipped';
  // Not sent now: never later. A follow-up resent by a retry an hour on would arrive out of place.
  await refuse('not delivered');
  return 'failed';
}
