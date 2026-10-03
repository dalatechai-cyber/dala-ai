/**
 * The booking ports bound to the real world: Google Calendar on the service account, QPay with
 * the tenant's OWN merchant and payout account on the login its row names (`qpayLogin.ts`: the
 * platform's Quick QR partner login unless the tenant has its own), Messenger through the same
 * delivery path every reply takes, and the founder's alerts.
 *
 * `null` with the reason whenever anything is missing: a route answers 503 and the worker's
 * hook stays out of the way, so a half-configured deployment changes nothing for a customer.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { raiseAlert } from '../alerts/alert.ts';
import { quickQr, type QpayPort } from '../billing/qpay.ts';
import { deliverOutbound } from '../outbound/deliver.ts';
import { scheduleBookingSweep } from '../queue/qstash.ts';
import { buildDeliverDeps } from '../outbound/deliverDeps.ts';
import { googleCalendar } from './calendar.ts';
import { bookingEnvMode, type QpayMerchant } from './config.ts';
import type { BookingPorts } from './engine.ts';
import { linkSecret, publicOrigin } from './links.ts';
import { qpayLoginFor } from './qpayLogin.ts';
import { loadBookingWording } from './wording.ts';
import { bookingTurn, type TurnInput, type TurnResult } from './turn.ts';

const env = (k: string): string => (process.env[k] ?? '').trim();

/**
 * The QPay port for one tenant's merchant: its own payout account on every invoice, on the login
 * its row names, read now (never cached, rule 7). Missing anything: null, so no invoice is made;
 * never another login or another tenant's merchant instead. `fetchImpl` is the test seam.
 */
export function qpayPortFor(m: QpayMerchant, fetchImpl?: typeof fetch): QpayPort | null {
  const bank = m.bankAccounts[0];
  const login = qpayLoginFor(m);
  if (bank === undefined || !login.ok) {
    if (!login.ok) console.error(JSON.stringify({ level: 'error', event: 'booking.qpay_login_missing', missing: login.missing }));
    return null;
  }
  return quickQr({
    ...login.login, merchantId: m.merchantId, mccCode: m.mccCode,
    bankCode: bank.bankCode, bankAccount: bank.accountNumber, accountName: bank.accountName,
  }, fetchImpl ?? fetch);
}

export async function liveBookingPorts(db: SupabaseClient, opts: { graphVersionDefault?: () => string } = {}):
  Promise<{ ok: true; ports: BookingPorts } | { ok: false; detail: string }> {
  if (bookingEnvMode() === 'off') return { ok: false, detail: 'BOOKING_MODE is off' };
  const secret = linkSecret();
  const origin = publicOrigin();
  const email = (process.env['GOOGLE_SERVICE_ACCOUNT_EMAIL'] ?? '').trim();
  const key = process.env['GOOGLE_PRIVATE_KEY'] ?? '';
  const qpay = { username: env('QPAY_USERNAME'), password: env('QPAY_PASSWORD'), terminalId: env('QPAY_TERMINAL_ID') };
  const missing = [
    secret === null ? 'BOOKING_LINK_SECRET' : '', origin === null ? 'DALA_PUBLIC_URL' : '',
    email === '' ? 'GOOGLE_SERVICE_ACCOUNT_EMAIL' : '', key.trim() === '' ? 'GOOGLE_PRIVATE_KEY' : '',
    qpay.username === '' ? 'QPAY_USERNAME' : '', qpay.password === '' ? 'QPAY_PASSWORD' : '', qpay.terminalId === '' ? 'QPAY_TERMINAL_ID' : '',
    env('META_GRAPH_VERSION') === '' && opts.graphVersionDefault === undefined ? 'META_GRAPH_VERSION' : '',
  ].filter((m) => m !== '');
  if (missing.length > 0) return { ok: false, detail: `booking is not configured: ${missing.join(', ')}` };
  const wording = await loadBookingWording(db);
  if (!wording.ok) return { ok: false, detail: wording.detail };
  const ports: BookingPorts = {
    db,
    now: () => new Date(),
    calendar: googleCalendar({ email, privateKey: key }),
    qpayFor: (m: QpayMerchant) => qpayPortFor(m),
    wording: wording.wording,
    origin: origin as string,
    secret: secret as string,
    deliver: (a) => deliverOutbound(
      buildDeliverDeps({
        db, tenantId: a.tenantId, channelId: a.channelId, outboundId: a.outboundId, attempts: a.attempts, now: new Date(),
        ...(a.tokenChannelId === undefined ? {} : { tokenChannelId: a.tokenChannelId }),
      }),
      a,
    ),
    graphVersionDefault: opts.graphVersionDefault ?? (() => env('META_GRAPH_VERSION')),
    scheduleSweep: async (at, key) => {
      const r = await scheduleBookingSweep(at, key);
      if (!r.ok) console.error(JSON.stringify({ level: 'error', event: 'booking.sweep_not_scheduled', detail: r.detail }));
    },
    alert: async (a) => {
      try {
        const r = await raiseAlert(db, {
          tenantId: a.tenantId, severity: 'critical', kind: a.kind, dedupKey: a.dedupKey, body: a.body, route: 'now', repeat: 'once',
        });
        if (r.outcome === 'failed' || r.outcome === 'recorded_undelivered') console.error('[booking] alert_undelivered', { kind: a.kind, ...r });
      } catch (e) {
        console.error('[booking] alert_failed', { kind: a.kind, error: e instanceof Error ? e.name : 'error' });
      }
    },
    log: (level, event, fields) => {
      const line = JSON.stringify({ level, event: `booking.${event}`, ...fields });
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.info(line);
    },
  };
  return { ok: true, ports };
}

/**
 * The reception worker's booking effect. `{}` while `BOOKING_MODE` is off: the worker then has
 * no `bookingTurn` at all, so nothing about a reply changes. On, the ports are built once per
 * job on first need, and any failure (unconfigured, unsigned, a throw) answers `handled:
 * false`, so the ordinary reply path answers the customer.
 */
export function bookingTurnEffect(db: SupabaseClient): { bookingTurn?: (input: TurnInput) => Promise<TurnResult> } {
  if (bookingEnvMode() === 'off') return {};
  let built: ReturnType<typeof liveBookingPorts> | null = null;
  return {
    bookingTurn: async (input) => {
      try {
        built ??= liveBookingPorts(db);
        const ports = await built;
        if (!ports.ok) return { handled: false, reason: `unconfigured: ${ports.detail}` };
        return await bookingTurn(ports.ports, input);
      } catch (e) {
        console.error(JSON.stringify({ level: 'error', event: 'booking.turn_threw', error: e instanceof Error ? e.message : 'error' }));
        return { handled: false, reason: 'threw' };
      }
    },
  };
}
