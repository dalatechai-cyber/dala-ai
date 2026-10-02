/**
 * What happens to a held time after the customer has agreed: the QPay invoice, the payment,
 * the booking in the calendar, the release, and every message and alert on the way.
 *
 * ## One function settles a hold, whoever calls it
 *
 * QPay's callback, the pay page's poll, the customer writing again and the minute sweep all
 * call `settleHold`. It asks QPay (never trusts a callback's body), records each payment once
 * (`booking_record_payment`, unique on QPay's payment id), and moves the hold on. Called twice
 * at once, the database decides: one call records a payment and the other reads `duplicate`;
 * one call books and the other reads `already_booked`. Every message to the customer is keyed
 * by the hold and the event (`booking:<hold>:<event>`), so it goes out once.
 *
 * ## Money is never silent
 *
 * A payment that cannot be turned into a booking (the time went, the calendar refused, a
 * second payment, a short one, an answer QPay sent that cannot be read) pages the founder at
 * once with the customer's name, phone and amount, so a person can refund or rebook.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { QpayPort } from '../billing/qpay.ts';
import { formatMnt } from '../billing/templates.ts';
import type { DeliverOutcome } from '../outbound/deliver.ts';
import { claim, draftOnce } from '../outbound/claim.ts';
import type { QuickReply } from '../meta/send.ts';
import { canDeliver } from '../channel/delivery.ts';
import { tenantClock } from '../time/clock.ts';
import { WEEKDAYS } from '../prompt/tenant.ts';
import { eventIdForHold, type CalendarPort, type NewEvent } from './calendar.ts';
import type { BookingConfig, QpayMerchant } from './config.ts';
import { callbackUrl, payUrl } from './links.ts';
import {
  endHold, finishInvoice, claimInvoice, holdInvoices, markBooked, markUnbooked, readConfig, readHold, readTenantFacts,
  recordPayment, setCalendarState, holdsToSweep, recentlyEnded, logEvent, type Hold, type Invoice, type TenantFacts,
} from './store.ts';
import { say, type BookingWording } from './wording.ts';

export type BookingDeliverArgs = {
  tenantId: string; channelId: string; pageId: string; recipientId: string; outboundId: string; body: string;
  attempts: number; graphVersion: string; tokenChannelId?: string; quickReplies?: readonly QuickReply[]; linkButtonTitle?: string;
};

export type BookingAlert = { tenantId: string; kind: string; dedupKey: string; body: string };

export type BookingPorts = {
  db: SupabaseClient;
  now: () => Date;
  calendar: CalendarPort;
  /** The QPay port for one merchant, on the platform's QPay credentials. Null: not configured. */
  qpayFor: (merchant: QpayMerchant) => QpayPort | null;
  wording: BookingWording;
  origin: string;
  secret: string;
  deliver: (a: BookingDeliverArgs) => Promise<DeliverOutcome>;
  graphVersionDefault: () => string;
  /** Pages the founder (`route: now`). Must never reject. */
  alert: (a: BookingAlert) => Promise<void>;
  log: (level: 'info' | 'warn' | 'error', event: string, fields?: Record<string, unknown>) => void;
};

const rec = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

// ---------------------------------------------------------------------------
// How a hold reads to a person
// ---------------------------------------------------------------------------

/** «Маргааш», «Өнөөдөр», or «10 сарын 5, Бямба» on the tenant's clock. */
export function dayLabel(w: BookingWording, date: string, now: Date, timezone: string): string {
  const today = tenantClock(now, timezone).date;
  const tomorrow = tenantClock(new Date(now.getTime() + 24 * 3600_000), timezone).date;
  if (date === today) return say(w, 'booking_day_today');
  if (date === tomorrow) return say(w, 'booking_day_tomorrow');
  const [, m, d] = date.split('-');
  const noon = new Date(`${date}T12:00:00Z`);
  const weekday = WEEKDAYS.find((x) => x.dow === noon.getUTCDay())?.label ?? '';
  return say(w, 'booking_date', { month: String(Number(m)), day: String(Number(d)), weekday });
}

/** `14:00` on the tenant's clock. */
export function timeLabel(at: Date, timezone: string): string {
  return tenantClock(at, timezone).time;
}

export function stylistLabel(staffName: string, level: string): string {
  return `${staffName} (${level})`;
}

/** The test mark, when the hold is a test: «ТЕСТ — …». */
export function marked(w: BookingWording, isTest: boolean, text: string): string {
  return isTest ? `${say(w, 'booking_test_prefix')} — ${text}` : text;
}

/** The website's event: «<phone> - <service>», and its description lines, plus where it came from. */
export function bookingEvent(hold: Hold, facts: TenantFacts, kind: 'hold' | 'booking', invoiceIds: readonly string[]): Omit<NewEvent, 'id'> {
  const test = hold.isTest ? 'ТЕСТ – ' : '';
  const ub = (d: Date) => `${tenantClock(d, facts.timezone).date} ${tenantClock(d, facts.timezone).time}`;
  const lines = [
    ...(hold.isTest ? ['ТЕСТ — test booking made in Messenger by a listed tester (test deposit). Not a real customer.'] : []),
    ...(kind === 'hold' ? ['HOLD — a customer in Messenger is paying the deposit for this time. It is released automatically if unpaid.'] : []),
    `Name: ${hold.customerName}`,
    `Phone: ${hold.customerPhone}`,
    `Price: ${hold.depositMnt} MNT (${hold.level})`,
    `Duration: ${hold.minutes} min`,
    `Customer: ${hold.gender === 'female' ? 'Эмэгтэй (female)' : 'Эрэгтэй (male)'}`,
    `Deposit terms accepted: ${ub(hold.agreedAt)} (${facts.timezone})`,
    `Agreed: «${hold.agreementText}»`,
    ...(invoiceIds.length > 0 ? [`QPay invoice: ${invoiceIds.join(', ')}`] : []),
    `Source: Messenger (Дали)`,
    `Branch: ${facts.displayName}`,
  ];
  return {
    summary: kind === 'hold'
      ? `${test}HOLD – ${hold.customerPhone} - ${hold.service} (awaiting deposit)`
      : `${test}${hold.customerPhone} - ${hold.service}`,
    description: lines.join('\n'),
    start: hold.startsAt,
    end: hold.endsAt,
    transparency: 'opaque',
    privateProps: { dalaBookingHold: hold.id, dalaBookingState: kind },
  };
}

// ---------------------------------------------------------------------------
// Telling the customer
// ---------------------------------------------------------------------------

type ChannelView = { pageId: string; tokenChannelId?: string; deliverable: boolean; graphVersion: string } | null;

async function channelFor(ports: BookingPorts, tenantId: string, channelId: string, psid: string): Promise<ChannelView> {
  const { data, error } = await ports.db.from('tenant_channels')
    .select('external_id, via_channel_id, delivery_mode, test_sender_ids, graph_version_override')
    .eq('tenant_id', tenantId).eq('id', channelId).maybeSingle();
  if (error || data === null) return null;
  const c = rec(data);
  let pageId = String(c['external_id'] ?? '');
  const via = typeof c['via_channel_id'] === 'string' && c['via_channel_id'] !== '' ? String(c['via_channel_id']) : null;
  if (via !== null) {
    const v = await ports.db.from('tenant_channels').select('external_id').eq('tenant_id', tenantId).eq('id', via).maybeSingle();
    if (v.error || v.data === null) return null;
    pageId = String(rec(v.data)['external_id'] ?? '');
  }
  const mode = String(c['delivery_mode'] ?? '');
  const testers = Array.isArray(c['test_sender_ids']) ? (c['test_sender_ids'] as unknown[]).map(String) : [];
  const override = c['graph_version_override'];
  return {
    pageId,
    ...(via === null ? {} : { tokenChannelId: via }),
    deliverable: canDeliver(mode).deliver || (mode === 'shadow' && testers.includes(psid)),
    graphVersion: typeof override === 'string' && override !== '' ? override : ports.graphVersionDefault(),
  };
}

export type Notified = 'sent' | 'already' | 'not_delivering' | 'failed';

/**
 * One message to the hold's customer, keyed by the hold and the event so it goes out once.
 * `kind = 'reply'` like every answer, so whatever asks "was this conversation answered" sees it.
 */
export async function notify(ports: BookingPorts, hold: Hold, event: string, body: string, extras: {
  quickReplies?: readonly QuickReply[]; linkButtonTitle?: string;
} = {}): Promise<Notified> {
  const { db } = ports;
  const drafted = await draftOnce(db, {
    tenantId: hold.tenantId, kind: 'reply', dedupKey: `booking:${hold.id}:${event}`, body,
    channelId: hold.channelId, conversationId: hold.conversationId,
  });
  if (!drafted.ok) {
    ports.log('error', 'booking_notify_draft_failed', { holdId: hold.id, event, detail: drafted.detail });
    return 'failed';
  }
  if (drafted.row.state === 'sent') return 'already';
  const channel = await channelFor(ports, hold.tenantId, hold.channelId, hold.psid);
  if (channel === null) {
    ports.log('error', 'booking_notify_channel_unreadable', { holdId: hold.id, event });
    return 'failed';
  }
  if (!channel.deliverable) {
    ports.log('info', 'booking_notify_not_delivering', { holdId: hold.id, event });
    return 'not_delivering';
  }
  const held = await claim(db, { id: drafted.row.id, tenantId: hold.tenantId, now: ports.now() });
  if (held.outcome === 'already_sent') return 'already';
  if (held.outcome !== 'claimed') {
    ports.log(held.outcome === 'unavailable' ? 'error' : 'info', 'booking_notify_not_claimed', { holdId: hold.id, event, outcome: held.outcome });
    return held.outcome === 'unavailable' ? 'failed' : 'already';
  }
  const sent = await ports.deliver({
    tenantId: hold.tenantId, channelId: hold.channelId, pageId: channel.pageId, recipientId: hold.psid,
    outboundId: held.id, body: held.body, attempts: held.attempts, graphVersion: channel.graphVersion,
    ...(channel.tokenChannelId === undefined ? {} : { tokenChannelId: channel.tokenChannelId }),
    ...(extras.quickReplies === undefined ? {} : { quickReplies: extras.quickReplies }),
    ...(extras.linkButtonTitle === undefined ? {} : { linkButtonTitle: extras.linkButtonTitle }),
  });
  if (sent.outcome === 'sent') return 'sent';
  ports.log('error', 'booking_notify_not_sent', { holdId: hold.id, event, outcome: sent.outcome });
  return 'failed';
}

/** The founder's page about one hold: who, what, how much, and what to do. */
function alertBody(hold: Hold, facts: TenantFacts | null, headline: string, todo: string): string {
  const tz = facts?.timezone ?? 'Asia/Ulaanbaatar';
  return [
    `${hold.isTest ? '[ТЕСТ] ' : ''}${headline}`,
    `${facts?.displayName ?? hold.tenantId}: ${hold.customerName}, ${hold.customerPhone}`,
    `${hold.service}, ${hold.staffName} (${hold.level}), ${tenantClock(hold.startsAt, tz).date} ${tenantClock(hold.startsAt, tz).time}`,
    `Deposit ${formatMnt(hold.depositMnt)}. Hold ${hold.id}`,
    todo,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// QPay
// ---------------------------------------------------------------------------

export type InvoiceOutcome = { ok: true; invoice: Invoice } | { ok: false; detail: string };

/**
 * A fresh QPay invoice for a held time, five minutes of QR. Claimed in our table first; an
 * answer we cannot read leaves the row `unknown` and nothing is shown, so nobody pays it.
 */
export async function createInvoice(ports: BookingPorts, hold: Hold, config: BookingConfig): Promise<InvoiceOutcome> {
  const qpay = ports.qpayFor(config.qpay);
  if (qpay === null) return { ok: false, detail: 'QPay is not configured' };
  const claimed = await claimInvoice(ports.db, { tenantId: hold.tenantId, holdId: hold.id, amountMnt: hold.depositMnt });
  if (!claimed.ok) return claimed;
  const token = await qpay.token();
  if (!token.ok) {
    await finishInvoice(ports.db, claimed.invoice.id, { state: 'refused' });
    return { ok: false, detail: token.detail };
  }
  const made = await qpay.createInvoice(token.token, {
    amountMnt: hold.depositMnt,
    // The website's description, «Name - Phone», so the salon reads both alike in its QPay app.
    description: `${hold.customerName} - ${hold.customerPhone}`.slice(0, 255),
    callbackUrl: callbackUrl(ports.origin, ports.secret, hold.id),
  });
  if (!made.ok) {
    await finishInvoice(ports.db, claimed.invoice.id, { state: made.outcome === 'refused' ? 'refused' : 'unknown' });
    return { ok: false, detail: made.detail };
  }
  const qrExpiresAt = new Date(Math.min(ports.now().getTime() + config.qrMinutes * 60_000, hold.expiresAt.getTime()));
  const done = await finishInvoice(ports.db, claimed.invoice.id, {
    state: 'open', qpayInvoiceId: made.invoiceId, qrImage: made.qrImage, qrText: made.qrText, urls: made.urls, qrExpiresAt,
  });
  if (!done.ok) {
    // QPay made it and we could not record it: never shown, so never paid. Cancel it.
    await qpay.cancelInvoice(token.token, made.invoiceId);
    return done;
  }
  return {
    ok: true,
    invoice: { ...claimed.invoice, state: 'open', qpayInvoiceId: made.invoiceId, qrImage: made.qrImage, qrText: made.qrText, urls: made.urls, qrExpiresAt },
  };
}

/**
 * The invoice a customer should pay now: the newest open one whose QR still has half a minute,
 * or a fresh one. A redelivered message never makes a second invoice for a QR still showing.
 */
export async function currentInvoice(ports: BookingPorts, hold: Hold, config: BookingConfig): Promise<InvoiceOutcome> {
  const list = await holdInvoices(ports.db, hold.id);
  if (!list.ok) return list;
  const live = list.invoices.filter((i) => i.state === 'open' && i.qrExpiresAt !== null
    && i.qrExpiresAt.getTime() > ports.now().getTime() + 30_000);
  const newest = live[live.length - 1];
  return newest === undefined ? createInvoice(ports, hold, config) : { ok: true, invoice: newest };
}

// ---------------------------------------------------------------------------
// Settling
// ---------------------------------------------------------------------------

export type SettleOutcome =
  | 'booked' | 'already_booked' | 'paid_unbooked' | 'unpaid' | 'ended' | 'undetermined' | 'calendar_pending' | 'unavailable';

/** Close the hold's booking session, best-effort: a session left open is closed by idleness. */
async function closeSession(ports: BookingPorts, hold: Hold, reason: string): Promise<void> {
  const { error } = await ports.db.from('booking_sessions')
    .update({ closed_at: ports.now().toISOString(), close_reason: reason, updated_at: ports.now().toISOString() })
    .eq('id', hold.sessionId).is('closed_at', null);
  if (error) ports.log('error', 'booking_session_close_failed', { holdId: hold.id, detail: error.message });
}

/**
 * Ask QPay about every invoice of this hold and record what it says. Returns the payments
 * recorded NOW (not seen before), or `undetermined` when any answer cannot be read.
 */
async function collectPayments(ports: BookingPorts, hold: Hold, config: BookingConfig, facts: TenantFacts | null):
  Promise<{ ok: true; fresh: { key: string; disposition: string; amount: number }[] } | { ok: false; detail: string }> {
  const invoices = await holdInvoices(ports.db, hold.id);
  if (!invoices.ok) return invoices;
  const asked = invoices.invoices.filter((i) => i.qpayInvoiceId !== null && i.state !== 'refused');
  if (asked.length === 0) return { ok: true, fresh: [] };
  const qpay = ports.qpayFor(config.qpay);
  if (qpay === null) return { ok: false, detail: 'QPay is not configured' };
  const token = await qpay.token();
  if (!token.ok) return { ok: false, detail: token.detail };
  const fresh: { key: string; disposition: string; amount: number }[] = [];
  for (const inv of asked) {
    const check = await qpay.checkPayment(token.token, inv.qpayInvoiceId as string);
    if (!check.ok) return { ok: false, detail: check.detail };
    if (!check.determined) {
      await ports.alert({
        tenantId: hold.tenantId, kind: 'booking.payment_unreadable', dedupKey: `booking.payment_unreadable:${inv.id}`,
        body: alertBody(hold, facts, '⚠️ QPay answered about a deposit in a way the platform cannot read. Nothing was recorded.',
          `Check QPay invoice ${inv.qpayInvoiceId} in the merchant app. Reason: ${check.reason}`),
      });
      return { ok: false, detail: `undetermined: ${check.reason}` };
    }
    for (const p of check.payments) {
      const r = await recordPayment(ports.db, {
        holdId: hold.id, invoiceId: inv.id, paymentKey: p.key, amountMnt: p.amountMnt, paidAt: p.paidAt, qpayInvoiceId: inv.qpayInvoiceId as string,
      });
      if (!r.ok) return r;
      if (!r.duplicate) fresh.push({ key: p.key, disposition: r.disposition, amount: p.amountMnt });
    }
  }
  return { ok: true, fresh };
}

/** Other events that block [start, end): anything opaque in the calendar that is not ours. */
async function othersInWindow(ports: BookingPorts, hold: Hold, timezone: string): Promise<{ ok: true; clash: boolean } | { ok: false; detail: string }> {
  const ours = eventIdForHold(hold.id);
  const ev = await ports.calendar.events(hold.calendarId, hold.startsAt, hold.endsAt, timezone);
  if (!ev.ok) return { ok: false, detail: ev.detail };
  return {
    ok: true,
    clash: ev.events.some((e) => e.blocks && e.id !== ours
      && e.start.getTime() < hold.endsAt.getTime() && hold.startsAt.getTime() < e.end.getTime()),
  };
}

/** Write the booking into the calendar under our own id: the hold event becomes the booking. */
async function writeBooking(ports: BookingPorts, hold: Hold, facts: TenantFacts): Promise<{ ok: true; eventId: string } | { ok: false; detail: string }> {
  const id = eventIdForHold(hold.id);
  const inv = await holdInvoices(ports.db, hold.id);
  const ids = inv.ok ? inv.invoices.map((i) => i.qpayInvoiceId).filter((x): x is string => x !== null) : [];
  const body = bookingEvent(hold, facts, 'booking', ids);
  const patched = await ports.calendar.patch(hold.calendarId, id, body);
  if (patched.ok) return { ok: true, eventId: id };
  if (patched.outcome !== 'gone') return { ok: false, detail: patched.detail };
  const inserted = await ports.calendar.insert(hold.calendarId, { id, ...body });
  if (inserted.ok) return { ok: true, eventId: id };
  if (inserted.outcome === 'exists') {
    const again = await ports.calendar.patch(hold.calendarId, id, body);
    return again.ok ? { ok: true, eventId: id } : { ok: false, detail: again.outcome === 'gone' ? 'event gone and its id taken' : again.detail };
  }
  return { ok: false, detail: inserted.detail };
}

/** Our hold event out of the calendar, recorded. Best-effort; logged when it fails. */
async function removeOurEvent(ports: BookingPorts, hold: Hold): Promise<void> {
  if (hold.calendarState !== 'held') return;
  const id = eventIdForHold(hold.id);
  const r = await ports.calendar.remove(hold.calendarId, id);
  if (!r.ok) {
    ports.log('error', 'booking_hold_event_not_removed', { holdId: hold.id, detail: r.detail });
    return;
  }
  const s = await setCalendarState(ports.db, hold.id, id, 'deleted');
  if (!s.ok) ports.log('error', 'booking_calendar_state_failed', { holdId: hold.id, detail: s.detail });
}

async function tellPaidUnbooked(ports: BookingPorts, hold: Hold, facts: TenantFacts | null, why: string): Promise<void> {
  await ports.alert({
    tenantId: hold.tenantId, kind: 'booking.paid_unbooked', dedupKey: `booking.paid_unbooked:${hold.id}`,
    body: alertBody(hold, facts, '⚠️ A customer PAID the deposit in Messenger and has NO appointment.',
      `${why}\nCall the customer: book another time by hand, or refund the deposit in QPay.`),
  });
  await notify(ports, hold, 'paid_unbooked', marked(ports.wording, hold.isTest, say(ports.wording, 'booking_paid_unbooked')));
  await closeSession(ports, hold, 'paid_unbooked');
}

/**
 * The one way a hold moves after it is made. Idempotent; safe to call from anywhere, any
 * number of times, concurrently.
 */
export async function settleHold(ports: BookingPorts, holdId: string): Promise<SettleOutcome> {
  const read = await readHold(ports.db, holdId);
  if (!read.ok || read.hold === null) {
    ports.log('error', 'booking_hold_unreadable', { holdId, detail: read.ok ? 'no such hold' : read.detail });
    return 'unavailable';
  }
  let hold = read.hold;
  const cfg = await readConfig(ports.db, hold.tenantId);
  const factsRead = await readTenantFacts(ports.db, hold.tenantId);
  const facts = factsRead.ok ? factsRead.facts : null;
  // Money first: even a hold whose tenant switched the flow off still records what was paid.
  if (!cfg.ok || !cfg.present || !cfg.valid) {
    ports.log('error', 'booking_config_unusable', { holdId, detail: cfg.ok ? (cfg.present ? (cfg as { detail: string }).detail : 'no row') : cfg.detail });
    await ports.alert({
      tenantId: hold.tenantId, kind: 'booking.config_unusable', dedupKey: `booking.config_unusable:${hold.tenantId}`,
      body: alertBody(hold, facts, '⚠️ A Messenger booking cannot be checked: the tenant\'s booking settings are missing or invalid.',
        'Fix booking_config for this tenant; until then this deposit is not read from QPay.'),
    });
    return 'unavailable';
  }
  const config = cfg.config;

  const paid = await collectPayments(ports, hold, config, facts);
  if (!paid.ok) {
    ports.log('warn', 'booking_payments_undetermined', { holdId, detail: paid.detail });
    return 'undetermined';
  }
  for (const f of paid.fresh) {
    ports.log('info', 'booking_payment_recorded', { holdId, disposition: f.disposition, amount: f.amount });
    if (f.disposition === 'excess') {
      await ports.alert({
        tenantId: hold.tenantId, kind: 'booking.excess_payment', dedupKey: `booking.excess_payment:${f.key}`,
        body: alertBody(hold, facts, `⚠️ A second deposit payment arrived for one Messenger booking (${formatMnt(f.amount)}).`,
          'Only one appointment exists. Refund the extra payment in QPay.'),
      });
      await notify(ports, hold, `excess:${f.key}`, marked(ports.wording, hold.isTest, say(ports.wording, 'booking_excess')));
    }
    if (f.disposition === 'short') {
      await ports.alert({
        tenantId: hold.tenantId, kind: 'booking.short_payment', dedupKey: `booking.short_payment:${f.key}`,
        body: alertBody(hold, facts, `⚠️ A deposit payment smaller than the deposit arrived (${formatMnt(f.amount)}).`,
          'Nothing was booked on it. Refund it in QPay, or book by hand.'),
      });
    }
  }

  const again = await readHold(ports.db, holdId);
  if (!again.ok || again.hold === null) return 'unavailable';
  hold = again.hold;

  if (hold.state === 'booked') return 'already_booked';
  if (hold.state === 'expired' || hold.state === 'released') return 'ended';
  if (hold.state === 'held') return 'unpaid';
  if (hold.state === 'paid_unbooked') {
    await removeOurEvent(ports, hold);
    await tellPaidUnbooked(ports, hold, facts, 'The payment came after the hold had ended, and the time is no longer free.');
    return 'paid_unbooked';
  }

  // paid: put it in the calendar, unless somebody else has the time now.
  if (facts === null) return 'unavailable';
  const clash = await othersInWindow(ports, hold, facts.timezone);
  if (!clash.ok) {
    await ports.alert({
      tenantId: hold.tenantId, kind: 'booking.calendar_failed', dedupKey: `booking.calendar_failed:${hold.id}`,
      body: alertBody(hold, facts, '⚠️ A deposit is PAID but the calendar cannot be read to book it. The platform keeps trying every minute.',
        `If this does not clear, book the time by hand. Detail: ${clash.detail}`),
    });
    return 'calendar_pending';
  }
  if (clash.clash) {
    const marked2 = await markUnbooked(ports.db, hold.id, 'the time was taken in the calendar before the booking was written');
    if (!marked2.ok) return 'unavailable';
    await removeOurEvent(ports, hold);
    await tellPaidUnbooked(ports, hold, facts, 'Another booking (the website or a person) took the time before the deposit arrived.');
    return 'paid_unbooked';
  }
  const written = await writeBooking(ports, hold, facts);
  if (!written.ok) {
    await ports.alert({
      tenantId: hold.tenantId, kind: 'booking.calendar_failed', dedupKey: `booking.calendar_failed:${hold.id}`,
      body: alertBody(hold, facts, '⚠️ A deposit is PAID but the booking could not be written to the calendar. The platform keeps trying every minute.',
        `If this does not clear, book the time by hand. Detail: ${written.detail}`),
    });
    return 'calendar_pending';
  }
  const booked = await markBooked(ports.db, hold.id, written.eventId);
  if (!booked.ok) return 'unavailable';
  if (booked.outcome !== 'booked' && booked.outcome !== 'already_booked') return 'unavailable';
  if (hold.late) {
    await ports.alert({
      tenantId: hold.tenantId, kind: 'booking.late_booked', dedupKey: `booking.late_booked:${hold.id}`,
      body: alertBody(hold, facts, 'ℹ️ A deposit arrived after its hold ended; the time was still free and is now booked.', 'Nothing to do.'),
    });
  }
  const w = ports.wording;
  const date = tenantClock(hold.startsAt, facts.timezone).date;
  const text = say(w, 'booking_confirmed', {
    service: hold.service,
    stylist: stylistLabel(hold.staffName, hold.level),
    date: dayLabel(w, date, ports.now(), facts.timezone),
    time: timeLabel(hold.startsAt, facts.timezone),
    branch: facts.branch,
    address: facts.address ?? facts.displayName,
  });
  await notify(ports, hold, 'booked', marked(w, hold.isTest, text));
  await closeSession(ports, hold, 'booked');
  return 'booked';
}

/** Cancel every QPay invoice of a hold that ended unpaid. Best-effort, logged. */
async function cancelInvoices(ports: BookingPorts, hold: Hold, config: BookingConfig): Promise<void> {
  const inv = await holdInvoices(ports.db, hold.id);
  if (!inv.ok) return;
  const open = inv.invoices.filter((i) => i.state === 'open' && i.qpayInvoiceId !== null);
  if (open.length === 0) return;
  const qpay = ports.qpayFor(config.qpay);
  if (qpay === null) return;
  const token = await qpay.token();
  if (!token.ok) return;
  for (const i of open) {
    const r = await qpay.cancelInvoice(token.token, i.qpayInvoiceId as string);
    if (r.ok) await finishInvoice(ports.db, i.id, { state: 'cancelled' });
    else ports.log('warn', 'booking_invoice_not_cancelled', { holdId: hold.id, detail: r.detail });
  }
}

/**
 * Let an unpaid hold go: QPay asked one last time (a payment wins), then the time is released,
 * the invoices cancelled, the calendar event removed, and the customer told once.
 */
export async function expireHold(ports: BookingPorts, holdId: string, kind: 'expired' | 'released' = 'expired', reason = 'unpaid when the hold ended'):
  Promise<'expired' | 'released' | 'paid' | 'not_due' | 'unavailable'> {
  const settled = await settleHold(ports, holdId);
  if (settled === 'booked' || settled === 'already_booked' || settled === 'paid_unbooked' || settled === 'calendar_pending') return 'paid';
  if (settled === 'undetermined' && kind === 'expired') return 'unavailable';
  const ended = await endHold(ports.db, holdId, kind, reason);
  if (!ended.ok) return 'unavailable';
  if (ended.outcome === 'not_due') return 'not_due';
  if (ended.outcome === 'has_payment') return 'paid';
  const read = await readHold(ports.db, holdId);
  if (!read.ok || read.hold === null) return 'unavailable';
  const hold = read.hold;
  if (ended.outcome !== 'expired' && ended.outcome !== 'released') {
    // Already ended by another caller: nothing more to do here.
    return hold.state === 'released' ? 'released' : 'expired';
  }
  const cfg = await readConfig(ports.db, hold.tenantId);
  if (cfg.ok && cfg.present && cfg.valid) await cancelInvoices(ports, hold, cfg.config);
  await removeOurEvent(ports, hold);
  if (kind === 'expired') {
    const facts = await readTenantFacts(ports.db, hold.tenantId);
    if (facts.ok) {
      const w = ports.wording;
      const date = tenantClock(hold.startsAt, facts.facts.timezone).date;
      await notify(ports, hold, 'expired', marked(w, hold.isTest, say(w, 'booking_expired', {
        date: dayLabel(w, date, ports.now(), facts.facts.timezone), time: timeLabel(hold.startsAt, facts.facts.timezone),
      })));
    }
    await closeSession(ports, hold, 'expired');
  }
  await logEvent(ports.db, { tenantId: hold.tenantId, holdId: hold.id, kind: `hold.${kind}.cleaned` });
  return kind;
}

/** The minute sweep: unpaid holds past their time, paid holds not yet in the calendar, late payments. */
export async function sweep(ports: BookingPorts): Promise<{ expired: number; booked: number; pending: number; failed: number }> {
  const out = { expired: 0, booked: 0, pending: 0, failed: 0 };
  const due = await holdsToSweep(ports.db, ports.now());
  if (!due.ok) {
    ports.log('error', 'booking_sweep_unreadable', { detail: due.detail });
    out.failed += 1;
    return out;
  }
  for (const h of due.holds) {
    if (h.state === 'held') {
      const r = await expireHold(ports, h.id);
      if (r === 'expired') out.expired += 1;
      else if (r === 'paid') out.booked += 1;
      else if (r === 'unavailable') {
        out.failed += 1;
        // QPay cannot be read, so the time is neither released nor booked. Retried every
        // minute; after a quarter of an hour a person is told, once, with the customer.
        if (ports.now().getTime() - h.expiresAt.getTime() > 15 * 60_000) {
          await ports.alert({
            tenantId: h.tenantId, kind: 'booking.stuck', dedupKey: `booking.stuck:${h.id}`,
            body: alertBody(h, null, '⚠️ A Messenger booking hold is past its time and QPay cannot be asked whether it was paid.',
              'The time stays held until QPay answers. Check the QPay merchant app for this customer\'s payment.'),
          });
        }
      }
    } else {
      const r = await settleHold(ports, h.id);
      if (r === 'booked' || r === 'already_booked') out.booked += 1;
      else if (r === 'calendar_pending') out.pending += 1;
      else if (r === 'unavailable' || r === 'undetermined') out.failed += 1;
    }
  }
  const ended = await recentlyEnded(ports.db, ports.now());
  if (ended.ok) {
    for (const h of ended.holds) {
      const r = await settleHold(ports, h.id);
      if (r === 'booked') out.booked += 1;
    }
  }
  return out;
}
