import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseChannel, type ChannelObservation } from './channel.ts';
import type { BusinessHours } from '../reception/volatile.ts';

const DAILY: BusinessHours[] = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday, opens: '10:00', closes: '20:00', closed: false,
}));

const NOW = new Date('2026-09-04T06:00:00Z');        // 14:00 in Ulaanbaatar
const FRESH = new Date('2026-09-04T05:30:00Z');      // half an hour ago
const STALE = new Date('2026-09-04T02:00:00Z');      // four open hours ago

function obs(over: Partial<ChannelObservation> = {}): ChannelObservation {
  return {
    channelId: 'ch-1', tenantId: 't-1', externalId: '100000000000001',
    lastWebhookAt: FRESH, lastInboundMessageAt: FRESH,
    wentLiveAt: new Date('2026-08-01T00:00:00Z'),
    timezone: 'Asia/Ulaanbaatar', hours: DAILY, closures: [],
    thresholdOpenMinutes: 180, now: NOW,
    ...over,
  };
}

test('both streams flowing is healthy', () => {
  assert.equal(diagnoseChannel(obs()).state, 'healthy');
});

test('DONE-TEST: THE STANDBY TRAP — webhooks fresh, messages stale, and it says so', () => {
  // §3.7: with the Page Inbox app as primary receiver, Meta delivers into entry[].standby.
  // The webhook is well-formed, correctly signed, correctly routed — and dropped. Reception
  // answers nobody while `last_webhook_at` stays fresh, the token probe passes and the
  // reconciler sees a valid subscription. A watchdog keyed on webhook receipt alone, which
  // is what §3.10.5 designed, is GREEN through the whole outage.
  const d = diagnoseChannel(obs({ lastWebhookAt: FRESH, lastInboundMessageAt: STALE }));
  assert.equal(d.state, 'no_messages');
  assert.match(d.reason, /standby/);
  assert.match(d.reason, /webhooks are arriving/);
});

test('DONE-TEST: nothing arriving at all points at the token, not at standby', () => {
  const d = diagnoseChannel(obs({ lastWebhookAt: STALE, lastInboundMessageAt: STALE }));
  assert.equal(d.state, 'no_webhooks');
  assert.match(d.reason, /token or the subscription/);
});

test('DONE-TEST: a channel that never received anything names the FIELD SUBSCRIPTION', () => {
  // STATUS §5 item 15: a page-level subscribe returns {"success": true} even when the app
  // has never enabled that field, and no events are ever delivered. The remedy is a
  // different screen from the one a dead token sends you to, so the alert must not
  // conflate them.
  const d = diagnoseChannel(obs({
    lastWebhookAt: null, lastInboundMessageAt: null, wentLiveAt: STALE,
  }));
  assert.equal(d.state, 'no_webhooks');
  assert.equal(d.state === 'no_webhooks' && d.everReceived, false);
  assert.match(d.reason, /NEVER received/);
  assert.match(d.reason, /field subscription/);
});

test('ONE FAULT, ONE NAME: no webhooks does not also report no messages', () => {
  // If nothing is arriving then nothing can become a message, so reporting both would be
  // one fault wearing two names — and the second name sends the operator to the wrong
  // screen. The upstream failure wins.
  const d = diagnoseChannel(obs({ lastWebhookAt: STALE, lastInboundMessageAt: null }));
  assert.equal(d.state, 'no_webhooks');
});

test('DONE-TEST: NO HOURS CONFIGURED IS A PROVISIONING GAP, not an outage and not unknown', () => {
  // The live false alarm this state exists for: tenant #0 went live with no `business_hours`
  // rows, so every run produced `unknown` with the date in the dedup key — one alert a day,
  // for ever, on the first channel the platform ever watched. Seeding the hours would have
  // fixed that channel and left the class: every tenant is in this window on day one.
  const d = diagnoseChannel(obs({ hours: [] }));
  assert.equal(d.state, 'not_provisioned');
  assert.match(d.reason, /business_hours/);
});

test('a channel that was never stamped live and never received is not provisioned either', () => {
  // Same class, different missing field: there is no clock to measure from, so there is no
  // outage to report — only a setup that stops short.
  const d = diagnoseChannel(obs({ lastWebhookAt: null, lastInboundMessageAt: null, wentLiveAt: null }));
  assert.equal(d.state, 'not_provisioned');
});

test('a schedule that exists and says CLOSED stays unknown, and keeps alerting', () => {
  // The boundary of the new state. Hours entered and marked closed are an answer, so a
  // fortnight of them on a live channel is a fact worth an operator's glance — unlike a
  // form nobody has filled in, it does not resolve itself by being ignored.
  const shut = DAILY.map((h) => ({ ...h, closed: true, opens: null, closes: null }));
  const d = diagnoseChannel(obs({
    hours: shut, lastWebhookAt: new Date('2026-08-01T00:00:00Z'),
    lastInboundMessageAt: new Date('2026-08-01T00:00:00Z'),
  }));
  assert.equal(d.state, 'unknown');
});

test('overnight, neither stream is a fault', () => {
  // 21:00Z is 05:00 local, hours before opening. Yesterday's last message is ten minutes
  // of open time away, not eleven hours.
  const night = new Date('2026-09-04T21:00:00Z');
  const d = diagnoseChannel(obs({
    now: night,
    lastWebhookAt: new Date('2026-09-04T11:50:00Z'),
    lastInboundMessageAt: new Date('2026-09-04T11:50:00Z'),
  }));
  assert.equal(d.state, 'healthy');
});

test('the alert text carries the Page id and a time, not just a state', () => {
  // An alert that says "channel unhealthy" sends the founder to a query. One that names
  // the Page and how long it has been quiet is actionable from the notification itself.
  const d = diagnoseChannel(obs({ lastWebhookAt: STALE, lastInboundMessageAt: STALE }));
  assert.match(d.reason, /\d+\.\dh/);
});
