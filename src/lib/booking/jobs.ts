/**
 * The three public entry points around a hold, as plain functions over `BookingPorts` so a
 * test reaches every branch without Next.js: the pay page, QPay's callback, and the sweep.
 */
import { tenantClock } from '../time/clock.ts';
import { currentInvoice, dayLabel, settleHold, stylistLabel, sweep, timeLabel, type BookingPorts } from './engine.ts';
import { verifyHold } from './links.ts';
import { followUps } from './turn.ts';
import { notFoundPage, renderBookingPage, type PageOutcome, type PageSummary } from './page.ts';
import { holdInvoices, readConfig, readHold, readTenantFacts, type Hold } from './store.ts';

/** New QR codes per hold. The website has no cap; this one stops a page reloaded in a loop from making invoices. */
export const CODES_PER_HOLD = 6;
/** How often the pay page's poll may ask QPay about one hold. */
export const POLL_CHECK_INTERVAL_MS = 15_000;

function summaryOf(ports: BookingPorts, hold: Hold, tenantName: string, timezone: string): PageSummary {
  const date = tenantClock(hold.startsAt, timezone).date;
  return {
    tenantName, service: hold.service, stylist: stylistLabel(hold.staffName, hold.level),
    when: `${dayLabel(ports.wording, date, ports.now(), timezone)}, ${timeLabel(hold.startsAt, timezone)}`,
    amountMnt: hold.depositMnt, isTest: hold.isTest,
  };
}

export async function runPayPage(ports: BookingPorts, input: { token: string; method: 'GET' | 'POST'; stateOnly: boolean }): Promise<PageOutcome> {
  const holdId = verifyHold(ports.secret, 'pay', input.token);
  if (holdId === null) return notFoundPage();
  if (input.stateOnly) {
    // The poll: ask QPay (at most every 15 s per hold, however many pages poll), so a customer
    // who has just paid sees it within seconds without the shared QPay login being hammered.
    const settled = await settleHold(ports, holdId, { minCheckIntervalMs: POLL_CHECK_INTERVAL_MS });
    const read = await readHold(ports.db, holdId);
    const state = read.ok && read.hold !== null ? read.hold.state : 'unknown';
    return { status: 200, contentType: 'json', html: JSON.stringify({ state, settled }) };
  }
  const read = await readHold(ports.db, holdId);
  if (!read.ok) return { status: 503, html: 'unavailable' };
  if (read.hold === null) return notFoundPage();
  const hold = read.hold;
  const facts = await readTenantFacts(ports.db, hold.tenantId);
  if (!facts.ok) return { status: 503, html: 'unavailable' };
  const summary = summaryOf(ports, hold, facts.facts.displayName, facts.facts.timezone);
  if (hold.state === 'paid' || hold.state === 'booked' || hold.state === 'paid_unbooked') return renderBookingPage({ kind: 'paid', summary }, ports.wording);
  if (hold.state !== 'held' || ports.now().getTime() >= hold.expiresAt.getTime()) return renderBookingPage({ kind: 'ended', summary }, ports.wording);

  const cfg = await readConfig(ports.db, hold.tenantId);
  if (!cfg.ok || !cfg.present || !cfg.valid) return { status: 503, html: 'unavailable' };
  const list = await holdInvoices(ports.db, hold.id);
  if (!list.ok) return { status: 503, html: 'unavailable' };
  const live = list.invoices.filter((i) => i.state === 'open' && i.qrExpiresAt !== null && i.qrExpiresAt.getTime() > ports.now().getTime());
  const newest = live[live.length - 1];

  if (input.method === 'POST') {
    if (newest === undefined) {
      if (list.invoices.length >= CODES_PER_HOLD) return renderBookingPage({ kind: 'wait', summary }, ports.wording);
      const made = await currentInvoice(ports, hold, cfg.config);
      if (!made.ok) ports.log('error', 'booking_renew_failed', { holdId: hold.id, detail: made.detail });
    }
    return { status: 303, html: '', redirect: true };
  }
  if (newest === undefined || newest.qrImage === null || newest.qrExpiresAt === null) return renderBookingPage({ kind: 'renew', summary }, ports.wording);
  return renderBookingPage({
    kind: 'code', summary, qrImage: newest.qrImage, urls: newest.urls,
    secondsLeft: Math.floor((newest.qrExpiresAt.getTime() - ports.now().getTime()) / 1000),
  }, ports.wording);
}

/** QPay's callback. The body is never read; the token names the hold and QPay is asked. */
export async function runQpayCallback(ports: BookingPorts, token: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const holdId = verifyHold(ports.secret, 'callback', token);
  if (holdId === null) return { status: 403, body: { error: 'bad token' } };
  const r = await settleHold(ports, holdId);
  // 503 makes QPay retry when nothing could be read; everything else is settled or not yet paid.
  return r === 'undetermined' || r === 'unavailable' ? { status: 503, body: { settled: r } } : { status: 200, body: { settled: r } };
}

export async function runSweep(ports: BookingPorts): Promise<{ status: number; body: Record<string, unknown> }> {
  const started = Date.now();
  const out = await sweep(ports);
  // What the sweep left of the route's 120 s, less a margin: follow-ups are the first to wait.
  const asked = await followUps(ports, Math.max(0, 100_000 - (Date.now() - started)));
  return { status: 200, body: { ...out, followUps: asked } };
}

// ---------------------------------------------------------------------------
// The routes' decisions, so the route files hold no branch (as every worker route here).
// ---------------------------------------------------------------------------

export type PortsBuilder = () => Promise<{ ok: true; ports: BookingPorts } | { ok: false; detail: string }>;

export async function payPageRoute(build: PortsBuilder, input: { token: string; method: 'GET' | 'POST'; stateOnly: boolean }): Promise<PageOutcome> {
  const built = await build();
  if (!built.ok) {
    console.error(JSON.stringify({ level: 'error', event: 'booking.page_unconfigured', detail: built.detail }));
    return { status: 503, html: 'unavailable' };
  }
  return runPayPage(built.ports, input);
}

export async function callbackRoute(build: PortsBuilder, token: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const built = await build();
  // 503: QPay retries, and the sweep finds the payment anyway once the deployment is fixed.
  if (!built.ok) return { status: 503, body: { error: 'booking unconfigured' } };
  return runQpayCallback(built.ports, token);
}

export async function sweepRoute(
  build: PortsBuilder, verify: (raw: string, signature: string | null) => Promise<boolean>, raw: string, signature: string | null,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!(await verify(raw, signature))) return { status: 401, body: { error: 'bad signature' } };
  const built = await build();
  // 200, not 503: an unconfigured deployment is not a failure QStash can retry away.
  if (!built.ok) return { status: 200, body: { disabled: built.detail } };
  return runSweep(built.ports);
}
