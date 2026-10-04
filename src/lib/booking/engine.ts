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
import { resolveOpenAlerts } from '../alerts/alert.ts';
import { claim, draftOnce } from '../outbound/claim.ts';
import type { QuickReply } from '../meta/send.ts';
import { canDeliver } from '../channel/delivery.ts';
import { tenantClock } from '../time/clock.ts';
import { WEEKDAYS } from '../prompt/tenant.ts';
import { eventIdForHold, type CalendarPort, type NewEvent } from './calendar.ts';
import type { BookingConfig, QpayMerchant } from './config.ts';
import { callbackUrl, payUrl } from './links.ts';
import {
  endHold, finishInvoice, claimInvoice, accountSharedWith, setHoldExpiry, REBOOK_OFFER_MINUTES, outboundExists, holdInvoices, markBooked, markUnbooked, readConfig, readHold, readTenantFacts,
  recordPayment, setCalendarState, holdsToSweep, holdsWithOpenInvoices, markChecked, markNotified, closeSessionRow, logEvent, type Hold, type Invoice, type TenantFacts,
} from './store.ts';
import { say, type BookingWording } from './wording.ts';

export type BookingDeliverArgs = {
  tenantId: string; channelId: string; pageId: string; recipientId: string; outboundId: string; body: string;
  attempts: number; graphVersion: string; tokenChannelId?: string; quickReplies?: readonly QuickReply[]; linkButtonTitle?: string;
};

/**
 * `repeat`: `once` (default) pages once per key; `on_change` opens an episode that stays silent
 * while open and is closed when the condition is seen to have cleared (`resolveOpenAlerts`).
 */
export type BookingAlert = { tenantId: string; kind: string; dedupKey: string; body: string; repeat?: 'once' | 'on_change' };

export type BookingPorts = {
  db: SupabaseClient;
  now: () => Date;
  calendar: CalendarPort;
  /**
   * The QPay port for one tenant's merchant and payout account, on the platform's QPay login.
   * Null: that login is not configured. Never another tenant's account instead.
   */
  qpayFor: (merchant: QpayMerchant) => QpayPort | null;
  wording: BookingWording;
  origin: string;
  secret: string;
  deliver: (a: BookingDeliverArgs) => Promise<DeliverOutcome>;
  graphVersionDefault: () => string;
  /**
   * One sweep at this moment (QStash), so a hold ends on time, not at the next minute. Optional;
   * must never reject: the minute sweep is the fallback.
   */
  scheduleSweep?: (at: Date, key: string) => Promise<void>;
  /** Pages the founder (`route: now`). Must never reject. */
  alert: (a: BookingAlert) => Promise<void>;
  log: (level: 'info' | 'warn' | 'error', event: string, fields?: Record<string, unknown>) => void;
};

/** «Цаг сонгох» under the «time released» message: a new booking, without typing (`turn.ts`). */
export const START = 'bk:start';

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
    `Customer: ${hold.gender === 'female' ? 'Эмэгтэй (female)' : hold.gender === 'male' ? 'Эрэгтэй (male)' : 'not recorded'}`,
    // Дали states no deposit terms in chat (founder): what the customer accepted is the summary.
    `Accepted in Messenger: ${ub(hold.agreedAt)} (${facts.timezone})`,
    `Summary accepted: «${hold.agreementText.replace(/\n/gu, ' / ')}»`,
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
  return deliverDrafted(ports, { tenantId: hold.tenantId, channelId: hold.channelId, psid: hold.psid }, drafted.row.id, { holdId: hold.id, event }, extras);
}

/**
 * Send one drafted booking message to its customer: the channel must deliver to them (live, or a
 * tester in shadow), the row is claimed so it goes out once, then the worker's own send.
 */
export async function deliverDrafted(ports: BookingPorts, to: { tenantId: string; channelId: string; psid: string }, outboundId: string,
  logFields: Record<string, unknown>, extras: { quickReplies?: readonly QuickReply[]; linkButtonTitle?: string } = {}): Promise<Notified> {
  const { db } = ports;
  const channel = await channelFor(ports, to.tenantId, to.channelId, to.psid);
  if (channel === null) {
    ports.log('error', 'booking_notify_channel_unreadable', logFields);
    return 'failed';
  }
  if (!channel.deliverable) {
    ports.log('info', 'booking_notify_not_delivering', logFields);
    return 'not_delivering';
  }
  const held = await claim(db, { id: outboundId, tenantId: to.tenantId, now: ports.now() });
  if (held.outcome === 'already_sent') return 'already';
  if (held.outcome !== 'claimed') {
    ports.log(held.outcome === 'unavailable' ? 'error' : 'info', 'booking_notify_not_claimed', { ...logFields, outcome: held.outcome });
    return held.outcome === 'unavailable' ? 'failed' : 'already';
  }
  const sent = await ports.deliver({
    tenantId: to.tenantId, channelId: to.channelId, pageId: channel.pageId, recipientId: to.psid,
    outboundId: held.id, body: held.body, attempts: held.attempts, graphVersion: channel.graphVersion,
    ...(channel.tokenChannelId === undefined ? {} : { tokenChannelId: channel.tokenChannelId }),
    ...(extras.quickReplies === undefined ? {} : { quickReplies: extras.quickReplies }),
    ...(extras.linkButtonTitle === undefined ? {} : { linkButtonTitle: extras.linkButtonTitle }),
  });
  if (sent.outcome === 'sent') return 'sent';
  ports.log('error', 'booking_notify_not_sent', { ...logFields, outcome: sent.outcome });
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
  // The merchant and the tenant's own payout account, complete, and nobody else's account: else no invoice.
  if (config.qpay === null) return { ok: false, detail: 'QPay is not connected for this tenant' };
  const qpay = ports.qpayFor(config.qpay);
  if (qpay === null) return { ok: false, detail: 'QPay is not configured (QPAY_USERNAME / QPAY_PASSWORD / QPAY_TERMINAL_ID)' };
  const shared = await accountSharedWith(ports.db, hold.tenantId, config.qpay);
  if (!shared.ok) return { ok: false, detail: shared.detail };
  if (shared.tenants.length > 0) {
    // Two tenants on one payout account would pay one branch's deposits to the other. (One
    // merchant for several branches is fine: the invoice's bank_accounts decides where money goes.)
    await ports.alert({
      tenantId: hold.tenantId, kind: 'booking.account_shared', dedupKey: `booking.account_shared:${hold.tenantId}`,
      body: `⚠️ In-chat booking refused a deposit: this tenant's QPay payout account is also in ${shared.tenants.length} other tenant(s)' booking_config. Each branch must be paid into its own. No invoice was made; fix the rows (scripts/booking/check.ts).`,
    });
    return { ok: false, detail: 'the QPay payout account is also another tenant\'s' };
  }
  const claimed = await claimInvoice(ports.db, {
    tenantId: hold.tenantId, holdId: hold.id, amountMnt: hold.depositMnt,
    merchantId: config.qpay.merchantId, payoutAccount: config.qpay.bankAccounts[0]?.accountNumber ?? '',
  });
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
  // The five minutes start now that the QR exists, and end for both at one instant: the held
  // time's end moves to the QR's (a turn's calendar and QPay calls never eat into them).
  const qrExpiresAt = new Date(ports.now().getTime() + config.holdMinutes * 60_000);
  // The held time's end first: a QR row is marked `open` (and so shown) only once the hold
  // lasts exactly as long. Not moved: the QR is cancelled and its row never opens.
  const moved = await setHoldExpiry(ports.db, hold.id, qrExpiresAt);
  if (!moved.ok) {
    await qpay.cancelInvoice(token.token, made.invoiceId);
    await finishInvoice(ports.db, claimed.invoice.id, { state: 'unknown', qpayInvoiceId: made.invoiceId });
    return { ok: false, detail: moved.detail };
  }
  hold.expiresAt = qrExpiresAt;
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
 * Asking QPay about an invoice already made, or cancelling it: on the platform's login, with the
 * merchant and account the invoice's row recorded, never the tenant's current row, which may have
 * changed since (set back to «not connected»). A check or a cancel sends no merchant or bank
 * details, only the login's token, and the mcc is never sent. One token per call.
 */
function invoiceSessions(ports: BookingPorts, hold: Hold): (inv: Invoice) => Promise<{ ok: true; port: QpayPort; token: string } | { ok: false; detail: string }> {
  let s: Promise<{ ok: true; port: QpayPort; token: string } | { ok: false; detail: string }> | undefined;
  return (inv) => {
    s ??= (async () => {
      // One episode per tenant, not per invoice: the login is gone from the environment while QR
      // codes are out, so their payments cannot be read. Closed once it reads again.
      const alertKey = `booking.qpay_login_missing:${hold.tenantId}`;
      const port = ports.qpayFor({
        merchantId: inv.merchantId, mccCode: '0000',
        bankAccounts: [{ bankCode: '-', accountNumber: inv.payoutAccount, accountName: '-' }],
      });
      if (port === null) {
        await ports.alert({
          tenantId: hold.tenantId, kind: 'booking.qpay_login_missing', dedupKey: alertKey, repeat: 'on_change',
          body: '⚠️ In-chat booking cannot read deposit payments: the QPay login QPAY_USERNAME / QPAY_PASSWORD / QPAY_TERMINAL_ID is missing from the environment while QR codes are out. Payments on them are not recorded until it is back; check the merchant app.',
        });
        return { ok: false as const, detail: `QPay is not configured (invoice ${inv.id} cannot be read)` };
      }
      const t = await port.token();
      if (t.ok) {
        const r = await resolveOpenAlerts(ports.db, { keyPrefix: alertKey, now: ports.now() });
        if (r.ok && r.resolved.length > 0) ports.log('info', 'booking_qpay_login_back', {});
      }
      return t.ok ? { ok: true as const, port, token: t.token } : { ok: false as const, detail: t.detail };
    })();
    return s;
  };
}

/**
 * The invoice a customer should pay now: the newest open one whose QR is still valid, or a fresh
 * one (only when none is: the first, or one QPay refused). Every QR of a hold ends with the hold,
 * so a new QR never lengthens the five minutes. A redelivered message never makes a second one.
 */
export async function currentInvoice(ports: BookingPorts, hold: Hold, config: BookingConfig): Promise<InvoiceOutcome> {
  if (ports.now().getTime() >= hold.expiresAt.getTime()) return { ok: false, detail: 'the hold has ended' };
  const list = await holdInvoices(ports.db, hold.id);
  if (!list.ok) return list;
  const live = list.invoices.filter((i) => i.state === 'open' && i.qrExpiresAt !== null
    && i.qrExpiresAt.getTime() > ports.now().getTime());
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
  const r = await closeSessionRow(ports.db, hold.sessionId, reason, ports.now());
  if (!r.ok) ports.log('error', 'booking_session_close_failed', { holdId: hold.id, detail: r.detail });
}

/**
 * Ask QPay about every invoice of this hold and record what it says. Returns the payments
 * recorded NOW (not seen before), or `undetermined` when any answer cannot be read.
 */
async function collectPayments(ports: BookingPorts, hold: Hold, facts: TenantFacts | null):
  Promise<{ ok: true; fresh: { key: string; disposition: string; amount: number }[] } | { ok: false; detail: string }> {
  const invoices = await holdInvoices(ports.db, hold.id);
  if (!invoices.ok) return invoices;
  const asked = invoices.invoices.filter((i) => i.qpayInvoiceId !== null && i.state !== 'refused');
  if (asked.length === 0) return { ok: true, fresh: [] };
  const session = invoiceSessions(ports, hold);
  const fresh: { key: string; disposition: string; amount: number }[] = [];
  for (const inv of asked) {
    // Asked about the invoice its row records, whatever the tenant's row says now.
    const s = await session(inv);
    if (!s.ok) return { ok: false, detail: s.detail };
    const check = await s.port.checkPayment(s.token, inv.qpayInvoiceId as string);
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
      // An invoice that paid the hold is no longer "open": the sweep stops asking about it (a
      // second payment on it still arrives by QPay's callback, which asks about every invoice).
      if (r.disposition !== 'short' && inv.state === 'open') {
        const f = await finishInvoice(ports.db, inv.id, { state: 'paid' });
        if (!f.ok) ports.log('warn', 'booking_invoice_paid_mark_failed', { holdId: hold.id, detail: f.detail });
        else inv.state = 'paid';
      }
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
export async function removeOurEvent(ports: BookingPorts, hold: Hold): Promise<void> {
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

/**
 * A paid deposit with no time: Дали offers the customer the nearest free times (a tap books one
 * on the same deposit, `turn.ts` `offerRebook`), or, with nothing to offer, says a person will
 * call. The founder is paged at once either way, to refund or rebook.
 */
async function tellPaidUnbooked(ports: BookingPorts, hold: Hold, facts: TenantFacts | null, why: string, config: BookingConfig): Promise<void> {
  // A rebooked deposit that lost its time again is a new round: told and paged again, never
  // swallowed by the first round's keys.
  const round = hold.rebookedAt === null ? '0' : String(hold.rebookedAt.getTime());
  // This round was told already (the page always goes before the mark): a second callback, a
  // retry, a customer's message never pages again, so a «refund it» is never followed by «offered».
  if (hold.notifiedAt !== null) return;
  // A round whose plain line («a person will call») was already drafted stays plain: an offer
  // after it could book a deposit the founder was told to refund.
  const plainKey = `booking:${hold.id}:paid_unbooked:${round}`;
  const plainDrafted = await outboundExists(ports.db, hold.tenantId, plainKey);
  if (plainDrafted === null) {
    // Unreadable: nothing said to the customer yet; untold, so the sweep asks again each minute.
    // The founder knows at once that a paid deposit has no time, and to wait for the next page.
    ports.log('error', 'booking_paid_unbooked_unreadable', { holdId: hold.id });
    await ports.alert({
      tenantId: hold.tenantId, kind: 'booking.paid_unbooked', dedupKey: `booking.paid_unbooked:${hold.id}:${round}:unreadable`,
      body: alertBody(hold, facts, '⚠️ A customer PAID the deposit in Messenger and has NO appointment.',
        `${why}\nThe platform could not read its own records to tell the customer; it retries every minute. If you already had a message about this deposit, follow that one. If not, wait for the next message before refunding or booking by hand.`),
    });
    return;
  }
  // turn.ts imports this module; imported here on use so neither loads the other half-made.
  const { offerRebook } = await import('./turn.ts');
  const offered = facts === null || plainDrafted ? 'no_offer' as const : await offerRebook(ports, hold, facts, config, round);
  const delivered = offered === 'sent' || offered === 'already';
  const until = new Date((hold.endedAt ?? ports.now()).getTime() + REBOOK_OFFER_MINUTES * 60_000);
  const untilText = facts === null ? '' : `${tenantClock(until, facts.timezone).time} Ulaanbaatar time`;
  // One page per outcome of the round: «offered» (with the deadline), «offer not delivered yet»
  // (retried every minute until the deadline; nothing to do before it), and «nothing offered»
  // (yours now). A retry that gets through is a new page, so the founder always knows which.
  // Only a send that failed is retried (`toldIf` leaves it untold); a channel that does not
  // deliver is told nothing ever, so it is «none»: the deposit is the founder's now.
  const outcome = delivered ? 'offered' : offered === 'failed' ? 'undelivered' : 'none';
  await ports.alert({
    tenantId: hold.tenantId, kind: 'booking.paid_unbooked', dedupKey: `booking.paid_unbooked:${hold.id}:${round}:${outcome}`,
    body: alertBody(hold, facts, '⚠️ A customer PAID the deposit in Messenger and has NO appointment.',
      outcome === 'offered'
        ? `${why}\nДали offered the customer the nearest free times, until ${untilText}. A time they pick by then is booked on this deposit and you get a second message. After it, the deposit is yours to refund in QPay or book by hand; a late tap no longer books.`
        : outcome === 'undelivered'
          ? `${why}\nThe offer of other times could not be delivered yet; it is retried every minute until ${untilText}. Do not refund or book by hand before then: you get another message when it goes out, or when the time is up.`
          : `${why}\nNo free time can be offered in the chat (none free, or the offer's time is up). Call the customer: book another time by hand, or refund the deposit in QPay.`),
  });
  if (offered !== 'no_offer') {
    await toldIf(ports, hold, offered);
    return;
  }
  const told = await notify(ports, hold, `paid_unbooked:${round}`, marked(ports.wording, hold.isTest, say(ports.wording, 'booking_paid_unbooked')));
  await closeSession(ports, hold, 'paid_unbooked');
  await toldIf(ports, hold, told);
}

/**
 * Mark the hold told once its message went out (or was out already, or the channel does not
 * deliver: nobody can be told then, and the founder's page carries it). A failed send leaves it
 * untold, so the sweep tries again.
 */
async function toldIf(ports: BookingPorts, hold: Hold, told: Notified): Promise<void> {
  if (told === 'failed' || hold.notifiedAt !== null) return;
  const m = await markNotified(ports.db, hold.id, ports.now());
  if (!m.ok) ports.log('warn', 'booking_mark_notified_failed', { holdId: hold.id, detail: m.detail });
}

/**
 * The one way a hold moves after it is made. Idempotent; safe to call from anywhere, any
 * number of times, concurrently.
 */
export async function settleHold(ports: BookingPorts, holdId: string, opts: { minCheckIntervalMs?: number } = {}): Promise<SettleOutcome> {
  const read = await readHold(ports.db, holdId);
  if (!read.ok || read.hold === null) {
    ports.log('error', 'booking_hold_unreadable', { holdId, detail: read.ok ? 'no such hold' : read.detail });
    return 'unavailable';
  }
  let hold = read.hold;
  const cfg = await readConfig(ports.db, hold.tenantId);
  const factsRead = await readTenantFacts(ports.db, hold.tenantId);
  const facts = factsRead.ok ? factsRead.facts : null;
  // Money first: even a hold whose tenant's settings are missing or invalid has its payments read
  // and recorded (each invoice on the login it was made on); only the booking waits for the fix.
  const usable = cfg.ok && cfg.present && cfg.valid;
  if (!usable) {
    ports.log('error', 'booking_config_unusable', { holdId, detail: cfg.ok ? (cfg.present ? (cfg as { detail: string }).detail : 'no row') : cfg.detail });
    await ports.alert({
      tenantId: hold.tenantId, kind: 'booking.config_unusable', dedupKey: `booking.config_unusable:${hold.tenantId}`,
      body: alertBody(hold, facts, '⚠️ A Messenger booking cannot be completed: the tenant\'s booking settings are missing or invalid.',
        'Its payments are still read from QPay and recorded; the booking and the customer\'s confirmation wait until booking_config is fixed.'),
    });
  }

  // The pay page polls every few seconds; QPay is asked at most once per interval per hold.
  const recently = opts.minCheckIntervalMs !== undefined && hold.lastCheckedAt !== null
    && ports.now().getTime() - hold.lastCheckedAt.getTime() < opts.minCheckIntervalMs;
  const paid = recently ? { ok: true as const, fresh: [] } : await collectPayments(ports, hold, facts);
  if (!paid.ok) {
    ports.log('warn', 'booking_payments_undetermined', { holdId, detail: paid.detail });
    return 'undetermined';
  }
  if (!recently) {
    const m = await markChecked(ports.db, hold.id, ports.now());
    if (!m.ok) ports.log('warn', 'booking_mark_checked_failed', { holdId, detail: m.detail });
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

  // Recorded; nothing is booked or rebooked on settings that cannot be read.
  if (!cfg.ok || !cfg.present || !cfg.valid) return 'unavailable';
  const config = cfg.config;
  const again = await readHold(ports.db, holdId);
  if (!again.ok || again.hold === null) return 'unavailable';
  hold = again.hold;

  if (hold.state === 'booked') {
    // Booked by an earlier call that may have died before telling anyone: the confirmation
    // (keyed, so never twice) and the session's close are repeated until they have happened.
    if (facts !== null) await confirmBooked(ports, hold, facts, config);
    return 'already_booked';
  }
  if (hold.state === 'expired' || hold.state === 'released') return 'ended';
  if (hold.state === 'held') return 'unpaid';
  if (hold.state === 'paid_unbooked') {
    await removeOurEvent(ports, hold);
    await tellPaidUnbooked(ports, hold, facts, 'The payment came after the hold had ended, and the time is no longer free.', config);
    return 'paid_unbooked';
  }

  // paid: put it in the calendar, unless somebody else has the time now.
  if (facts === null) return 'unavailable';
  const clash = await othersInWindow(ports, hold, facts.timezone);
  if (!clash.ok) {
    await ports.alert({
      tenantId: hold.tenantId, kind: 'booking.calendar_failed', dedupKey: `booking.calendar_failed:${hold.id}:${hold.rebookedAt === null ? '0' : hold.rebookedAt.getTime()}`,
      body: alertBody(hold, facts, '⚠️ A deposit is PAID but the calendar cannot be read to book it. The platform keeps trying every minute.',
        `If this does not clear, book the time by hand. Detail: ${clash.detail}`),
    });
    return 'calendar_pending';
  }
  if (clash.clash) {
    const marked2 = await markUnbooked(ports.db, hold.id, 'the time was taken in the calendar before the booking was written');
    if (!marked2.ok) return 'unavailable';
    await removeOurEvent(ports, hold);
    await tellPaidUnbooked(ports, hold, facts, 'Another booking (the website or a person) took the time before the deposit arrived.', config);
    return 'paid_unbooked';
  }
  const written = await writeBooking(ports, hold, facts);
  if (!written.ok) {
    await ports.alert({
      tenantId: hold.tenantId, kind: 'booking.calendar_failed', dedupKey: `booking.calendar_failed:${hold.id}:${hold.rebookedAt === null ? '0' : hold.rebookedAt.getTime()}`,
      body: alertBody(hold, facts, '⚠️ A deposit is PAID but the booking could not be written to the calendar. The platform keeps trying every minute.',
        `If this does not clear, book the time by hand. Detail: ${written.detail}`),
    });
    return 'calendar_pending';
  }
  const booked = await markBooked(ports.db, hold.id, written.eventId);
  if (!booked.ok) return 'unavailable';
  if (booked.outcome !== 'booked' && booked.outcome !== 'already_booked') return 'unavailable';
  if (hold.rebookedAt !== null) {
    await ports.alert({
      tenantId: hold.tenantId, kind: 'booking.rebooked', dedupKey: `booking.rebooked:${hold.id}`,
      body: alertBody(hold, facts, 'ℹ️ The customer whose deposit lost its time picked another free time in the chat: booked on the same deposit.',
        'Nothing to refund. (Above: the new time.)'),
    });
  } else if (hold.late) {
    await ports.alert({
      tenantId: hold.tenantId, kind: 'booking.late_booked', dedupKey: `booking.late_booked:${hold.id}`,
      body: alertBody(hold, facts, 'ℹ️ A deposit arrived after its hold ended; the time was still free and is now booked.', 'Nothing to do.'),
    });
  }
  await confirmBooked(ports, hold, facts, config);
  // The other QR codes of this hold can no longer be paid for nothing.
  await cancelInvoices(ports, hold);
  return 'booked';
}

/** The confirmation, once (keyed), and the booking chat closed. Safe to repeat. */
async function confirmBooked(ports: BookingPorts, hold: Hold, facts: TenantFacts, config: BookingConfig): Promise<void> {
  const w = ports.wording;
  const date = tenantClock(hold.startsAt, facts.timezone).date;
  const text = say(w, 'booking_confirmed', {
    service: hold.service,
    stylist: stylistLabel(hold.staffName, hold.level),
    date: dayLabel(w, date, ports.now(), facts.timezone),
    time: timeLabel(hold.startsAt, facts.timezone),
    branch: config.branchLabel ?? facts.branch,
    address: facts.address ?? facts.displayName,
  });
  const told = await notify(ports, hold, 'booked', marked(w, hold.isTest, text));
  await closeSession(ports, hold, 'booked');
  await toldIf(ports, hold, told);
}

/**
 * Cancel every still-open QPay invoice of a hold (it ended unpaid, or another of its codes paid
 * it). An invoice QPay would not cancel stays `open`, so the sweep keeps asking about it for a
 * day, and a person is told once.
 */
async function cancelInvoices(ports: BookingPorts, hold: Hold): Promise<void> {
  const inv = await holdInvoices(ports.db, hold.id);
  if (!inv.ok) return;
  // An invoice that carries a recorded payment is paid, whatever its row says: never "cancel" it.
  const { data: paidRows, error: paidErr } = await ports.db.from('booking_payments').select('invoice_id').eq('hold_id', hold.id);
  if (paidErr) return;
  const paidIds = new Set((paidRows ?? []).map((r) => String((r as Record<string, unknown>)['invoice_id'])));
  const open = inv.invoices.filter((i) => i.state === 'open' && i.qpayInvoiceId !== null && !paidIds.has(i.id));
  if (open.length === 0) return;
  const session = invoiceSessions(ports, hold);
  for (const i of open) {
    const s = await session(i);
    const r = !s.ok ? { ok: false as const, detail: s.detail } : await s.port.cancelInvoice(s.token, i.qpayInvoiceId as string);
    if (r.ok) {
      await finishInvoice(ports.db, i.id, { state: 'cancelled' });
      continue;
    }
    ports.log('warn', 'booking_invoice_not_cancelled', { holdId: hold.id, detail: r.detail });
    await ports.alert({
      tenantId: hold.tenantId, kind: 'booking.invoice_not_cancelled', dedupKey: `booking.invoice_not_cancelled:${i.id}`,
      body: alertBody(hold, null, `⚠️ A deposit QR code could not be cancelled in QPay (invoice ${i.qpayInvoiceId}).`,
        'It can still be paid. The platform keeps reading it for a day; a payment on it is recorded and paged.'),
    });
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
  // Nothing is released while QPay (or the tenant's settings) cannot say whether it was paid.
  if (settled === 'undetermined' || settled === 'unavailable') return 'unavailable';
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
  // Each invoice is cancelled on the login it was made on (its own row), so the tenant's current
  // settings, valid or not, never stand between an ended hold and its QR's cancellation.
  await cancelInvoices(ports, hold);
  await removeOurEvent(ports, hold);
  if (kind === 'expired') {
    const cfg = await readConfig(ports.db, hold.tenantId);
    const facts = await readTenantFacts(ports.db, hold.tenantId);
    if (facts.ok) {
      const w = ports.wording;
      const date = tenantClock(hold.startsAt, facts.facts.timezone).date;
      // The tenant's hold length; if the settings cannot be read now, the hold's own, from its row.
      const cfgMinutes = cfg.ok && cfg.present && cfg.valid ? cfg.config.holdMinutes
        : Math.max(1, Math.round((hold.expiresAt.getTime() - hold.createdAt.getTime()) / 60_000));
      await notify(ports, hold, 'expired', marked(w, hold.isTest, say(w, 'booking_expired', {
        minutes: String(cfgMinutes),
        date: dayLabel(w, date, ports.now(), facts.facts.timezone), time: timeLabel(hold.startsAt, facts.facts.timezone),
      })), { quickReplies: [{ title: say(w, 'booking_choose_again'), payload: START }] });
    }
    await closeSession(ports, hold, 'expired');
  }
  await logEvent(ports.db, { tenantId: hold.tenantId, holdId: hold.id, kind: `hold.${kind}.cleaned` });
  return kind;
}

/** No hold is started after this much of the sweep's run (route maxDuration 120 s). */
export const SWEEP_BUDGET_MS = 80_000;

/** The minute sweep: unpaid holds past their time, paid holds not yet in the calendar, late payments. */
export async function sweep(ports: BookingPorts): Promise<{ expired: number; booked: number; pending: number; failed: number }> {
  const out = { expired: 0, booked: 0, pending: 0, failed: 0 };
  const started = Date.now();
  const due = await holdsToSweep(ports.db, ports.now());
  if (!due.ok) {
    ports.log('error', 'booking_sweep_unreadable', { detail: due.detail });
    out.failed += 1;
    return out;
  }
  // One hold that throws or hangs never stops the others; the rest wait for the next minute.
  const each = async (h: Hold, run: (h: Hold) => Promise<void>) => {
    if (Date.now() - started > SWEEP_BUDGET_MS) return;
    try {
      await run(h);
    } catch (e) {
      out.failed += 1;
      ports.log('error', 'booking_sweep_hold_threw', { holdId: h.id, error: e instanceof Error ? e.message : 'error' });
    }
  };
  for (const h0 of due.holds) await each(h0, async (h) => {
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
  });
  const ended = await holdsWithOpenInvoices(ports.db, ports.now());
  if (!ended.ok) ports.log('error', 'booking_sweep_unreadable', { detail: ended.detail });
  else {
    for (const h0 of ended.holds) await each(h0, async (h) => {
      const r = await settleHold(ports, h.id);
      if (r === 'booked') out.booked += 1;
    });
  }
  return out;
}
