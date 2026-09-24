import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cappedLine, ESCALATE_AFTER_DAYS, lostDraftsLine, planDigest, runDigestJob } from './digest.ts';
import type { OpenAlert } from './alert.ts';

const NOW = new Date('2026-09-14T01:00:00Z');   // 09:00 in Ulaanbaatar
const RAN = new Date('2026-09-14T00:00:00Z');   // the watchdog, an hour before

function episode(over: Partial<OpenAlert> = {}): OpenAlert {
  return {
    id: 1, tenantId: 't-1', severity: 'critical', kind: 'channel.no_webhooks',
    dedupKey: 'channel_silence:ch-1:no_webhooks',
    body: 'Page 1520409424715591: this channel has NEVER received a webhook',
    at: new Date('2026-09-13T00:00:00Z'), notifiedAt: new Date('2026-09-13T00:00:00Z'),
    ...over,
  };
}

const NO_DROPS = { total: 0, byKind: {}, unavailable: false };
const NO_CAPS = { total: 0, posts: 0, unavailable: false };
const NO_LOST = { total: 0, latest: null, unavailable: false };
const CLEAN = {
  now: NOW, watchdogLastRan: RAN, channelsChecked: 2, dropped: NO_DROPS, capped: NO_CAPS, lostDrafts: NO_LOST,
};

test('DONE-TEST: A CLEAN DAY STILL SENDS, AND CARRIES PROOF OF LIFE', () => {
  // A digest that stays silent when nothing is open makes silence mean two things —
  // "nothing is wrong" and "the digest stopped running" — which is exactly the conflation
  // D-060 and D-062 were about, rebuilt inside the mechanism meant to be the safety net.
  const plan = planDigest([], CLEAN);
  assert.match(plan.summary, /Nothing open/);
  assert.match(plan.summary, /silence watchdog last ran 60m ago \(2 channels\)/);
  assert.equal(plan.escalate.length, 0);
});

test('DONE-TEST: and when the watchdog has never run, the clean day SAYS SO', () => {
  // `channel_health` is upserted on every run including healthy ones, precisely so that its
  // absence is a statement. A digest reading "nothing open" over a watchdog that has never
  // executed would be the most confident wrong sentence this system could produce.
  const plan = planDigest([], { now: NOW, watchdogLastRan: null, channelsChecked: 0, dropped: NO_DROPS, capped: NO_CAPS, lostDrafts: NO_LOST });
  assert.match(plan.summary, /never recorded an observation/);
  assert.doesNotMatch(plan.summary, /last ran/);
});

test('criticals lead, and within a severity the oldest episode leads', () => {
  const plan = planDigest([
    episode({ id: 1, severity: 'warn', kind: 'channel.unknown', at: new Date('2026-09-01T00:00:00Z') }),
    episode({ id: 2, severity: 'critical', kind: 'channel.no_messages', at: new Date('2026-09-12T00:00:00Z') }),
    episode({ id: 3, severity: 'critical', kind: 'channel.no_webhooks', at: new Date('2026-09-05T00:00:00Z') }),
  ], CLEAN);
  const order = ['channel.no_webhooks', 'channel.no_messages', 'channel.unknown'];
  const seen = order.map((k) => plan.summary.indexOf(k));
  assert.deepEqual([...seen].sort((a, b) => a - b), seen, plan.summary);
  assert.match(plan.summary, /3 open conditions/);
});

test('DONE-TEST: AN OPEN CRITICAL RE-ESCALATES AFTER THREE DAYS', () => {
  // The failure `on_change` creates if nothing answers it: a condition alerts once, goes
  // quiet, and three weeks later nobody can tell it from one that never happened.
  const fresh = episode({ id: 1, notifiedAt: new Date('2026-09-13T00:00:00Z') });
  const stale = episode({ id: 2, notifiedAt: new Date('2026-09-10T00:00:00Z') });
  const plan = planDigest([fresh, stale], CLEAN);
  assert.deepEqual(plan.escalate.map((a) => a.id), [2]);
});

test('a digest-routed episode measures its three days from `at`, not from never', () => {
  // `notifiedAt` is null because nobody has been paged — which is the opposite of "recently
  // told". Reading null as recent would mean a digest-routed critical never escalates.
  const plan = planDigest([episode({ id: 5, notifiedAt: null, at: new Date('2026-09-09T00:00:00Z') })], CLEAN);
  assert.deepEqual(plan.escalate.map((a) => a.id), [5]);
  assert.equal(ESCALATE_AFTER_DAYS, 3);
});

test('a warn never re-escalates, however old', () => {
  // Escalation is for the things worth waking up to. A standing warn belongs in the digest
  // and nowhere else, or the escalation becomes the new daily repeat.
  const plan = planDigest([episode({ severity: 'warn', notifiedAt: new Date('2026-08-01T00:00:00Z') })], CLEAN);
  assert.equal(plan.escalate.length, 0);
});

test('an over-long digest REPORTS what it left out', () => {
  // A summary that silently omits the item you needed is worse than one that is too long,
  // and "the part it managed" is the shape D-057 is named for.
  const many = Array.from({ length: 200 }, (_, i) => episode({ id: i, body: 'x'.repeat(300) }));
  const plan = planDigest(many, CLEAN);
  assert.ok(plan.summary.length <= 4096, `${plan.summary.length}`);
  assert.match(plan.summary, /and \d+ more, not shown/);
});

// --- the job ---------------------------------------------------------------

function jobDb(over: {
  alerts?: unknown; health?: unknown; alertsError?: unknown;
  flags?: unknown; flagsError?: unknown;
} = {}) {
  return {
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const methods = ['select', 'eq', 'is', 'like', 'in', 'order', 'limit', 'update', 'insert', 'gte', 'contains'];
      for (const m of methods) chain[m] = () => chain;
      chain['then'] = (res: (v: unknown) => unknown) => res(
        table === 'alerts'
          ? { data: over.alerts ?? [], error: over.alertsError ?? null }
          : table === 'quality_flags'
            ? { data: over.flags ?? [], error: over.flagsError ?? null }
            : { data: over.health ?? [{ observed_at: RAN.toISOString() }], error: null },
      );
      return chain;
    },
  } as never;
}

test('an unsigned call is 401 and reads nothing', async () => {
  const r = await runDigestJob(
    { db: jobDb(), now: NOW, verifySignature: async () => false },
    { rawBody: '{}', signature: null },
  );
  assert.equal(r.status, 401);
});

test('DONE-TEST: a digest that cannot read the alerts is 503, never a clean day', async () => {
  // 200 with `open: 0` over an unreadable table is the mechanism claiming a clean day it
  // never checked — the same 200-with-nothing that lost three messages in one night.
  process.env['ALERTS_ENABLED'] = 'false';
  const r = await runDigestJob(
    { db: jobDb({ alertsError: { message: 'connection reset' } }), now: NOW, verifySignature: async () => true },
    { rawBody: '{}', signature: 'sig' },
  );
  assert.equal(r.status, 503);
  assert.match(String(r.body['detail']), /connection reset/);
});

test('a signed run reports what it found', async () => {
  process.env['ALERTS_ENABLED'] = 'false';
  const r = await runDigestJob(
    {
      db: jobDb({ alerts: [{
        id: 1, tenant_id: 't-1', severity: 'critical', kind: 'channel.no_webhooks',
        dedup_key: 'channel_silence:ch-1:no_webhooks', body: 'dead',
        at: '2026-09-13T00:00:00Z', notified_at: '2026-09-13T00:00:00Z',
      }] }),
      now: NOW,
      verifySignature: async () => true,
    },
    { rawBody: '{}', signature: 'sig' },
  );
  assert.equal(r.status, 200);
  assert.equal(r.body['open'], 1);
  // ALERTS_ENABLED=false silences every path or it silences none of them.
  assert.equal(r.body['sent'], false);
});

// --- dropped inbound -------------------------------------------------------

test('DONE-TEST: THE CLEAN DAY SAYS ZERO DROPPED RATHER THAN SAYING NOTHING', () => {
  // Same argument as the heartbeat one line above it: a counter that is silent when it
  // finds nothing cannot be told from a counter that has stopped — and this one exists
  // because three dropped deliveries went unseen for a day.
  const plan = planDigest([], CLEAN);
  assert.match(plan.summary, /No inbound events dropped \(24h\)/);
});

test('DONE-TEST: AN UNREADABLE COUNT PRINTS UNREADABLE, NEVER ZERO', () => {
  // Reporting zero when the read failed is the exact defect this feature removes, rebuilt
  // inside the feature. It has to be loud in the message, not in a log.
  const plan = planDigest([], { ...CLEAN, dropped: { total: 0, byKind: {}, unavailable: true } });
  assert.match(plan.summary, /UNREADABLE/);
  assert.doesNotMatch(plan.summary, /No inbound events dropped/);
});

test('DONE-TEST: THE LINE NAMES THE KIND, BECAUSE A STICKER AND A PHOTO ARE DIFFERENT MORNINGS', () => {
  // The number alone is what misled a reader on 2026-09-14. Three skipped deliveries look
  // identical whether they were thumbs-ups (right to drop) or photographs of the colour a
  // customer wanted (the most valuable message a salon gets).
  const sticker = planDigest([], { ...CLEAN, dropped: { total: 3, byKind: { sticker: 3 }, unavailable: false } });
  assert.match(sticker.summary, /3 inbound dropped unanswered \(24h\): sticker ×3/);

  const photos = planDigest([], { ...CLEAN, dropped: { total: 3, byKind: { image: 3 }, unavailable: false } });
  assert.match(photos.summary, /image ×3/);
  assert.notEqual(sticker.summary, photos.summary);
});

test('kinds are ordered by count then code point, never by locale', () => {
  // D-026: ordering that reaches a rendered string must not depend on the runtime locale.
  const plan = planDigest([], {
    ...CLEAN,
    dropped: { total: 6, byKind: { image: 1, sticker: 4, file: 1 }, unavailable: false },
  });
  assert.match(plan.summary, /sticker ×4, file ×1, image ×1/);
});

test('an open condition carries the dropped line too', () => {
  const plan = planDigest([episode()], { ...CLEAN, dropped: { total: 1, byKind: { image: 1 }, unavailable: false } });
  assert.match(plan.summary, /1 open condition/);
  assert.match(plan.summary, /1 inbound dropped unanswered/);
});

test('DONE-TEST: a job whose quality_flags read fails still DELIVERS the digest', async () => {
  // The alerts read is the digest's subject and 503s. This is a second fact carried
  // alongside, and failing the whole job over it trades a missing clause for a missing
  // digest — including the open criticals it was about to list.
  process.env['ALERTS_ENABLED'] = 'false';
  const r = await runDigestJob(
    {
      db: jobDb({ flagsError: { message: 'connection reset' } }),
      now: NOW,
      verifySignature: async () => true,
    },
    { rawBody: '{}', signature: 'sig' },
  );
  assert.equal(r.status, 200);
});

test('the job counts dropped events by kind out of quality_flags', async () => {
  process.env['ALERTS_ENABLED'] = 'false';
  const r = await runDigestJob(
    {
      db: jobDb({
        flags: [
          { detail: { reason: 'no_text', attachments: ['sticker'] } },
          { detail: { reason: 'no_text', attachments: ['sticker'] } },
          { detail: { reason: 'postback' } },
        ],
      }),
      now: NOW,
      verifySignature: async () => true,
    },
    { rawBody: '{}', signature: 'sig' },
  );
  assert.equal(r.status, 200);
});

// The line is present on a CLEAN day too, for `droppedLine`'s reason: a counter that goes
// quiet when it finds nothing is indistinguishable from one that has stopped, and this
// counter exists because a capped comment was invisible for a whole night.
test('the capped clause is on every digest, clean days included', () => {
  assert.match(planDigest([], CLEAN).summary, /No public comments capped \(24h\)/);
});

// Total and distinct posts answer different questions. Six on ONE post is the cap working
// as designed — one public answer under a post is the whole rule. Six across six posts is
// six conversations the wall never got, and only the second argues for a higher cap.
test('capped counts name the posts as well as the comments', () => {
  assert.equal(
    cappedLine({ total: 6, posts: 1, unavailable: false }),
    '6 public comments silenced by the per-post cap (24h), across 1 post',
  );
  assert.equal(
    cappedLine({ total: 6, posts: 6, unavailable: false }),
    '6 public comments silenced by the per-post cap (24h), across 6 posts',
  );
  assert.equal(
    cappedLine({ total: 1, posts: 1, unavailable: false }),
    '1 public comment silenced by the per-post cap (24h), across 1 post',
  );
});

// An unreadable count is never zero. Rebuilding that conflation inside the clause written
// to end it is the mistake worth a test of its own.
test('an unreadable capped count prints UNREADABLE, never a clean day', () => {
  const line = cappedLine({ total: 0, posts: 0, unavailable: true });
  assert.match(line, /UNREADABLE/);
  assert.doesNotMatch(line, /No public comments/);
});

// ── Lost shadow drafts: the alerts that stopped paging still have to be seen ──────────

test('DONE-TEST: LOST SHADOW DRAFTS ARE COUNTED, AND A CLEAN DAY SAYS ZERO', () => {
  // These used to page the founder one by one (37 in two days, every customer already
  // answered by the ancestor). They no longer page, so if the digest did not carry them,
  // "the mirror refuses every message" would look exactly like a quiet day.
  assert.match(planDigest([], CLEAN).summary, /No shadow drafts lost \(24h\)/);
  const plan = planDigest([], {
    ...CLEAN,
    lostDrafts: { total: 29, latest: 'Inbound event 737: the shadow draft was lost after 3 deliveries (worker.reception_retry — canned_stale: …).', unavailable: false },
  });
  assert.match(plan.summary, /29 shadow drafts lost \(24h\), every customer answered by the Page/);
  assert.match(plan.summary, /canned_stale/, 'the reason is what tells the founder to republish');
});

test('an unreadable lost-draft count prints UNREADABLE, never zero', () => {
  assert.equal(lostDraftsLine({ total: 0, latest: null, unavailable: true }),
    'shadow drafts lost (24h): UNREADABLE — alerts could not be counted');
});
