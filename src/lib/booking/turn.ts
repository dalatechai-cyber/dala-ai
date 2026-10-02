/**
 * One customer message inside a booking: which question it answers, and what Дали asks next.
 *
 * No model. Every line is a signed block (`wording.ts`) filled from the tenant's rows and the
 * calendar; every choice is a button (Messenger quick reply) whose title is also accepted when
 * typed. A message that answers none of the buttons is asked again once, then the flow steps
 * aside and the ordinary Дали answers it: a customer who changed the subject is never trapped.
 *
 * The steps: service group → service → who it is for (the gender rule) → stylist or «any» of a
 * level → day → time → name → phone → the deposit agreement → hold, invoice, «Төлбөр төлөх».
 * What happens after that is `engine.ts`.
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
import { bookingEvent, currentInvoice, dayLabel, expireHold, marked, settleHold, stylistLabel, timeLabel, type BookingPorts } from './engine.ts';
import { payUrl } from './links.ts';
import { freeStarts, isFree, openDays, type Interval, type OpenDay } from './slots.ts';
import {
  acquireHold, activeHolds, applyTurn, endHold, openSession, readConfig, readHold, readOpenSession, readTenantFacts,
  sessionHold, setCalendarState, type Hold, type Session, type TenantFacts,
} from './store.ts';
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

type Offer = { t: string; v: string };
type Step = 'group' | 'service' | 'gender' | 'stylist' | 'day' | 'time' | 'name' | 'phone' | 'agree' | 'pay';
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

/** A name: one to sixty characters with at least one letter. */
export function typedName(text: string): string | null {
  const t = text.normalize('NFC').trim().replace(/\s+/gu, ' ');
  const len = [...t].length;
  return len >= 1 && len <= 60 && /\p{L}/u.test(t) ? t : null;
}

function quickReplies(step: Step, offers: readonly Offer[], cancelTitle: string): QuickReply[] {
  return [...offers.map((o, i) => ({ title: o.t, payload: `bk:${step}:${i}` })), { title: cancelTitle, payload: CANCEL }];
}

/** Which offer, if any, this message picks. */
function picked(session: Session, input: TurnInput): Offer | 'cancel' | null {
  const offers = Array.isArray(session.data['offers']) ? (session.data['offers'] as Offer[]) : [];
  const p = input.quickReplyPayload;
  if (p === CANCEL) return 'cancel';
  if (p !== undefined && p.startsWith(`bk:${session.step}:`)) {
    const i = Number(p.slice(`bk:${session.step}:`.length));
    if (Number.isInteger(i) && i >= 0 && i < offers.length) return offers[i] as Offer;
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

/** Days that still have a start for this service on any of the chosen stylists. Null: calendar unreadable. */
async function dayOffers(c: Ctx, data: Record<string, unknown>): Promise<Offer[] | null> {
  const minutes = Number(data['minutes']);
  const who = candidates(c.config, data);
  const days = openDays({ now: c.now, timezone: c.facts.timezone, daysAhead: c.config.daysAhead, hours: c.input.hours, closures: c.input.closures });
  if (who.length === 0 || days.length === 0) return [];
  const busy = await busyOn(c.ports, who.map((s) => s.calendarId), c.now, (days[days.length - 1] as OpenDay).closesAt);
  if (busy === null) return null;
  return days.filter((d) => who.some((s) => freeStarts({
    day: d, minutes, stepMinutes: c.config.slotStepMinutes, now: c.now, minLeadMinutes: c.config.minLeadMinutes, busy: busy.get(s.calendarId) ?? [],
  }).length > 0)).map((d) => ({ t: dayLabel(c.ports.wording, d.date, c.now, c.facts.timezone), v: d.date }));
}

/** Starts on one day, fresh from the calendar. Null: calendar unreadable. */
async function timeOffers(c: Ctx, data: Record<string, unknown>): Promise<Offer[] | null> {
  const minutes = Number(data['minutes']);
  const who = candidates(c.config, data);
  const day = openDays({ now: c.now, timezone: c.facts.timezone, daysAhead: c.config.daysAhead, hours: c.input.hours, closures: c.input.closures })
    .find((d) => d.date === data['date']);
  if (day === undefined || who.length === 0) return [];
  const busy = await busyOn(c.ports, who.map((s) => s.calendarId), day.opensAt, day.closesAt);
  if (busy === null) return null;
  const starts = new Set<number>();
  for (const s of who) {
    for (const t of freeStarts({ day, minutes, stepMinutes: c.config.slotStepMinutes, now: c.now, minLeadMinutes: c.config.minLeadMinutes, busy: busy.get(s.calendarId) ?? [] })) {
      starts.add(t.getTime());
    }
  }
  return [...starts].sort((a, b) => a - b).slice(0, 12)
    .map((ms) => ({ t: timeLabel(new Date(ms), c.facts.timezone), v: new Date(ms).toISOString() }));
}

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

function firstQuestion(c: Ctx): Reply {
  const w = c.ports.wording;
  const groups = c.config.serviceGroups;
  if (groups.length === 1) {
    const g = groups[0] as BookingConfig['serviceGroups'][number];
    return ask('service', say(w, 'booking_ask_service'), g.services.map((s) => ({ t: s.label, v: s.name })), { group: 0 });
  }
  return ask('group', say(w, 'booking_ask_service_group'), groups.map((g, i) => ({ t: g.label, v: String(i) })), {});
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

async function afterStylist(c: Ctx, data: Record<string, unknown>): Promise<Reply> {
  const w = c.ports.wording;
  const days = await dayOffers(c, data);
  if (days === null) return unavailableReply(c, data);
  if (days.length === 0) {
    const gender = (data['gender'] === 'male' || data['gender'] === 'female') ? data['gender'] as Gender : null;
    return ask('stylist', say(w, 'booking_no_times'), stylistOffers(c.ports, c.config, gender), data);
  }
  return ask('day', say(w, 'booking_ask_day', { service: String(data['service']) }), days, data);
}

async function afterDay(c: Ctx, data: Record<string, unknown>, lead?: string): Promise<Reply> {
  const w = c.ports.wording;
  const times = await timeOffers(c, data);
  if (times === null) return unavailableReply(c, data);
  if (times.length === 0) {
    // The day filled up since it was offered: offer the days again.
    const back = await afterStylist(c, data);
    return { ...back, body: say(w, 'booking_slot_taken') };
  }
  const date = dayLabel(w, String(data['date']), c.now, c.facts.timezone);
  const body = say(w, 'booking_ask_time', { date });
  return ask('time', lead === undefined ? body : `${lead}\n${body}`, times, data);
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
  const gender = data['gender'] === 'male' ? 'male' as const : 'female' as const;

  let hold: Hold | null = null;
  // A redelivery of this very message: the session already holds a time. Pick it up.
  const prior = await sessionHold(ports.db, session.id);
  if (!prior.ok) return unavailableReply(c, data);
  if (prior.hold !== null && prior.hold.state === 'held') hold = prior.hold;

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
      if (got.acquired.outcome === 'session_has_hold') {
        const h = await readHold(ports.db, got.acquired.holdId);
        if (!h.ok || h.hold === null) return unavailableReply(c, data);
        hold = h.hold;
        break;
      }
      if (got.acquired.outcome === 'no_session') return unavailableReply(c, data);
      // Held in the database. Now in the calendar, where the website sees it.
      const candidate = got.acquired.hold;
      const id = eventIdForHold(candidate.id);
      const put = await ports.calendar.insert(candidate.calendarId, { id, ...bookingEvent(candidate, facts, 'hold', []) });
      if (!put.ok && put.outcome !== 'exists') {
        await endHold(ports.db, candidate.id, 'released', `calendar refused the hold: ${put.detail}`);
        return unavailableReply(c, data);
      }
      await setCalendarState(ports.db, candidate.id, id, 'held');
      candidate.calendarState = 'held';
      candidate.calendarEventId = id;
      // The second look: did the website (or a person) write into this time meanwhile?
      const ev = await ports.calendar.events(candidate.calendarId, start, end, facts.timezone);
      if (!ev.ok) {
        await expireHold(ports, candidate.id, 'released', 'calendar unreadable after the hold');
        return unavailableReply(c, data);
      }
      const clash = ev.events.some((e) => e.blocks && e.id !== id && e.start.getTime() < end.getTime() && start.getTime() < e.end.getTime());
      if (clash) {
        await expireHold(ports, candidate.id, 'released', 'the calendar had another booking in this time');
        continue;
      }
      hold = candidate;
      break;
    }
  }

  if (hold === null) {
    // Every stylist that could have taken it is taken: say so, offer the times left.
    return afterDay(c, data, say(w, 'booking_slot_taken'));
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
  const choice = picked(session, c.input);

  if (choice === 'cancel') {
    return { step, body: say(w, 'booking_cancelled'), offers: [], data, close: 'cancelled' };
  }

  // Free-text steps.
  if (step === 'name') {
    const name = typedName(c.input.text);
    if (name === null) return ask('name', say(w, 'booking_ask_name'), [], data);
    return ask('phone', say(w, 'booking_ask_phone'), [], { ...data, name });
  }
  if (step === 'phone') {
    const phone = typedPhone(c.input.text);
    if (phone === null) return ask('phone', say(w, 'booking_phone_invalid'), [], data);
    return ask('agree', say(w, 'booking_ask_agreement', { agreement: c.config.agreementText }), [{ t: say(w, 'booking_agree'), v: 'yes' }], { ...data, phone });
  }

  if (choice === null) {
    if (data['missed'] === true) return 'not_mine';
    const offers = Array.isArray(data['offers']) ? (data['offers'] as Offer[]) : [];
    return { step, body: say(w, 'booking_pick_from_list'), offers, data: { ...data, missed: true }, close: null };
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
    case 'day':
      return afterDay(c, { ...data, date: choice.v });
    case 'time':
      return ask('name', say(w, 'booking_ask_name'), [], { ...data, start: choice.v });
    case 'agree':
      return holdAndInvoice(c, session, data);
    default:
      return 'not_mine';
  }
}

/** A message while a payment is pending: settle, and let Дали answer anything else. */
async function duringPay(c: Ctx, session: Session): Promise<TurnResult> {
  const held = await sessionHold(c.ports.db, session.id);
  if (!held.ok) return { handled: false, reason: 'hold_unreadable' };
  const hold = held.hold;
  const cancel = picked(session, c.input) === 'cancel';
  if (hold === null) return { handled: false, reason: 'no_hold' };
  if (cancel && hold.state === 'held') {
    const r = await expireHold(c.ports, hold.id, 'released', 'the customer cancelled');
    if (r === 'released') {
      return draft(c, session, { step: 'pay', body: say(c.ports.wording, 'booking_cancelled'), offers: [], data: session.data, close: 'cancelled' });
    }
    return { handled: true, outboundId: null, quickReplies: [], detail: `cancel after payment: ${r}` };
  }
  const r = await settleHold(c.ports, hold.id);
  if (r === 'booked' || r === 'already_booked' || r === 'paid_unbooked') {
    return { handled: true, outboundId: null, quickReplies: [], detail: `settled: ${r}` };
  }
  if (r === 'unpaid' && c.now.getTime() >= hold.expiresAt.getTime()) {
    const e = await expireHold(c.ports, hold.id);
    return { handled: true, outboundId: null, quickReplies: [], detail: `expired on message: ${e}` };
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
