/**
 * One customer message inside a booking: which question it answers, and what Дали asks next.
 *
 * No model. Every line is a signed block (`wording.ts`) filled from the tenant's rows and the
 * calendar; every choice is a button (Messenger quick reply) whose title is also accepted when
 * typed. A message that answers none of the buttons is asked again once, then the flow steps
 * aside and the ordinary Дали answers it: a customer who changed the subject is never trapped.
 *
 * The steps: service group → service → who it is for (the gender rule) → stylist or «any» of a
 * level → WHEN (Дали asks the day and time; the customer types «маргааш 2 цагт» or taps a day)
 * → the free times nearest to what they asked, read from the real calendar → name → phone →
 * the summary with the deposit and Tara's terms, «Зөвшөөрч, захиалах» → hold, invoice,
 * «Төлбөр төлөх». A day and time already named in the first message («маргааш 14 цагт цаг
 * авъя») is used without asking again. A customer silent on the offered times is asked once
 * more (`followUps`). What happens after the pay button is `engine.ts`.
 */
import { replyDedupKey } from '../outbound/claim.ts';
import { formatMnt } from '../billing/templates.ts';
import { fold } from '../mn/text.ts';
import type { QuickReply } from '../meta/send.ts';
import type { BusinessHours, Closure } from '../reception/volatile.ts';
import { tenantClock } from '../time/clock.ts';
import { eventIdForHold } from './calendar.ts';
import {
  allServices, bookingEnvMode, customerMode, depositFor, entryFires, stylistButton,
  type BookingConfig, type Gender, type Stylist,
} from './config.ts';
import { bookingEvent, currentInvoice, dayLabel, deliverDrafted, expireHold, marked, settleHold, stylistLabel, timeLabel, type BookingPorts } from './engine.ts';
import { payUrl } from './links.ts';
import { freeStarts, isFree, openDays, type Interval, type OpenDay } from './slots.ts';
import {
  acquireHold, activeHolds, applyTurn, closeSessionRow, endHold, markFollowedUp, openSession, readConfig, readHold, readHoursAndClosures,
  readOpenSession, readTenantFacts, sessionHold, sessionsToFollowUp, setCalendarState, type Hold, type Session, type TenantFacts,
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

type Offer = { t: string; v: string };
type Step = 'group' | 'service' | 'gender' | 'stylist' | 'when' | 'time' | 'name' | 'phone' | 'agree' | 'pay';
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
function picked(session: Session, input: TurnInput, cancelTitle: string): Offer | 'cancel' | null {
  const offers = Array.isArray(session.data['offers']) ? (session.data['offers'] as Offer[]) : [];
  const p = input.quickReplyPayload;
  // «Цуцлах», tapped or typed, at every step: typing it is never taken as a name or a phone.
  if (p === CANCEL || sameChoice(input.text, cancelTitle)) return 'cancel';
  if (p !== undefined && p.startsWith(`bk:${session.step}:`)) {
    const v = p.slice(`bk:${session.step}:`.length);
    const hit = offers.find((o) => o.v === v);
    if (hit !== undefined) return hit;
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
    if (of.length >= 2) offers.push({ t: say(ports.wording, 'booking_any_of_level', { level: level.label }), v: `any:${level.key}` });
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
  const w = c.ports.wording;
  const local = tenantClock(c.now, c.facts.timezone);
  const want = parseWhen(c.input.respelled ?? c.input.text, { date: local.date, weekday: local.weekday }, { weekdays: false });
  const base: Record<string, unknown> = want === null ? {} : { want };
  const groups = c.config.serviceGroups;
  if (groups.length === 1) {
    const g = groups[0] as BookingConfig['serviceGroups'][number];
    return ask('service', say(w, 'booking_ask_service'), g.services.map((s) => ({ t: s.label, v: s.name })), { ...base, group: 0 });
  }
  return ask('group', say(w, 'booking_ask_service_group'), groups.map((g, i) => ({ t: g.label, v: String(i) })), base);
}

function afterService(c: Ctx, data: Record<string, unknown>): Reply {
  const w = c.ports.wording;
  if (c.config.genderRule) {
    const offers: Offer[] = [];
    if (c.config.stylists.some((s) => s.gender === 'female')) offers.push({ t: say(w, 'booking_gender_female'), v: 'female' });
    if (c.config.stylists.some((s) => s.gender === 'male')) offers.push({ t: say(w, 'booking_gender_male'), v: 'male' });
    return ask('gender', say(w, 'booking_ask_gender'), offers, data);
  }
  return ask('stylist', say(w, 'booking_ask_stylist'), stylistOffers(c.ports, c.config, null), data);
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
      dayFull = say(w, 'booking_day_full', { date: dayLabel(w, want.date, c.now, tz) });
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
  let body: string;
  if (lead !== undefined || dayFull !== null || t === null) {
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
      const got = await acquireHold(ports.db, {
        tenantId: session.tenantId, sessionId: session.id, expiresAt: new Date(c.now.getTime() + config.holdMinutes * 60_000),
        hold: {
          calendarId: s.calendarId, staffName: s.label, level: level.label, service: String(data['service']), minutes,
          startsAt: start, endsAt: end, depositMnt: deposit, customerName: String(data['name']), customerPhone: String(data['phone']),
          gender, agreedAt: c.now, agreementText: config.agreementText,
        },
      });
      if (!got.ok) return unavailableReply(c, data);
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

  // Free-text steps. Anything that is not a name or a phone is asked again ONCE, then the flow
  // steps aside so Дали answers it: a question is never stored as a name, never trapped.
  if (step === 'name') {
    const name = looksLikeName(c.input.text) ? typedName(c.input.text) : null;
    if (name !== null) return ask('phone', say(w, 'booking_ask_phone'), [], { ...data, name });
    if (data['missed'] === true) return 'not_mine';
    return { step, body: say(w, 'booking_ask_name'), offers: [], data: { ...data, missed: true }, close: null };
  }
  if (step === 'phone') {
    const phone = typedPhone(c.input.text);
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
    if (typed !== null) {
      return offerTimes(c, data, step === 'time' && typed.date === null ? { ...typed, date: String(data['date']) } : typed);
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
      const s = allServices(c.config).find((x) => x.name === choice.v);
      if (s === undefined) return 'not_mine';
      return afterService(c, { ...data, service: s.name, minutes: s.minutes });
    }
    case 'gender': {
      const gender = choice.v === 'male' ? 'male' : 'female';
      return ask('stylist', say(w, 'booking_ask_stylist'), stylistOffers(c.ports, c.config, gender), { ...data, gender });
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
    const r = await closeSessionRow(c.ports.db, session.id, reason, c.now);
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
  if (r === 'already_booked' || r === 'paid_unbooked' || r === 'ended') return over(`settled_${r}`);
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

    if (session === null) {
      const subject = { text: input.text, attachments: [], respelled: input.respelled };
      if (input.quickReplyPayload?.startsWith('bk:') !== true && !entryFires(cfg.config, subject)) {
        return { handled: false, reason: 'not_a_booking_message' };
      }
      if (input.quickReplyPayload?.startsWith('bk:') === true) return { handled: false, reason: 'button_of_a_closed_booking' };
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
 * calendar (some may have gone meanwhile). Once per booking chat, never after the chat idled out,
 * never for a customer the flow is not on for. Written through the same versioned turn as a
 * reply, so a customer answering at the same moment wins and the follow-up is dropped.
 */
export async function followUps(ports: BookingPorts): Promise<{ sent: number; skipped: number; failed: number }> {
  const out = { sent: 0, skipped: 0, failed: 0 };
  if (bookingEnvMode() === 'off' || missingBlocks(ports.wording).length > 0) return out;
  const now = ports.now();
  const due = await sessionsToFollowUp(ports.db, now, FOLLOW_UP_MINUTES, SESSION_IDLE_MINUTES);
  if (!due.ok) {
    ports.log('error', 'booking_follow_up_unreadable', { detail: due.detail });
    out.failed += 1;
    return out;
  }
  for (const session of due.sessions) {
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
  const cfg = await readConfig(ports.db, session.tenantId);
  if (!cfg.ok) return 'failed';
  if (!cfg.present || !cfg.valid) return 'skipped';
  const who = customerMode(bookingEnvMode(), cfg.mode, cfg.config, session.psid);
  if (!who.on || who.isTest !== session.isTest) return 'skipped';
  const facts = await readTenantFacts(ports.db, session.tenantId);
  if (!facts.ok) return 'failed';
  const local = tenantClock(now, facts.facts.timezone);
  const hc = await readHoursAndClosures(ports.db, session.tenantId, local.date);
  if (!hc.ok) return 'failed';
  const c: Ctx = {
    ports, config: cfg.config, facts: facts.facts, now,
    input: {
      tenantId: session.tenantId, channelId: session.channelId, conversationId: session.conversationId, psid: session.psid,
      mid: '', text: '', respelled: null, hours: hc.hours, closures: hc.closures,
    },
  };
  const data = { ...session.data };
  const stored = data['want'] as Want | undefined;
  const want: Want = { date: String(data['date']), hour: stored?.hour ?? null, minute: stored?.minute ?? 0, afternoon: stored?.afternoon ?? false };
  const offer = await offerTimes(c, data, want);
  // No time left to offer, or the calendar cannot be read: say nothing; the chat idles out.
  if (offer.step !== 'time' || offer.close !== null || offer.offers.length === 0) return 'skipped';
  const body = marked(ports.wording, session.isTest, `${say(ports.wording, 'booking_follow_up')}\n${offer.body}`);
  const applied = await applyTurn(ports.db, {
    tenantId: session.tenantId, session, dedupKey: `booking-followup:${session.id}`, step: 'time',
    data: { ...offer.data, offerStep: 'time' }, closeReason: null, body,
  });
  if (!applied.ok) {
    ports.log('error', 'booking_follow_up_failed', { sessionId: session.id, detail: applied.detail });
    return 'failed';
  }
  if (applied.turn.outcome === 'stale') return 'skipped';
  const marked2 = await markFollowedUp(ports.db, session.id, now);
  if (!marked2.ok) ports.log('error', 'booking_follow_up_mark_failed', { sessionId: session.id, detail: marked2.detail });
  if (applied.turn.outboundId === null) return 'skipped';
  const sent = await deliverDrafted(ports, { tenantId: session.tenantId, channelId: session.channelId, psid: session.psid }, applied.turn.outboundId,
    { sessionId: session.id, event: 'follow_up' }, { quickReplies: quickReplies('time', offer.offers, say(ports.wording, 'booking_cancel')) });
  return sent === 'sent' ? 'sent' : sent === 'failed' ? 'failed' : 'skipped';
}
