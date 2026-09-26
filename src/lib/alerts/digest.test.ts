import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cappedLine, composeDailyReport, DAILY_REPORT_LIMIT, DEFAULT_APP_SECTION_URL, ESCALATE_AFTER_DAYS, fetchAppSection,
  lostDraftsLine, planDigest, renderYesterday, reportWindow, runDigestJob, SECTION_JOIN, type ReportSection,
} from './digest.ts';
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
      const methods = ['select', 'eq', 'is', 'like', 'in', 'order', 'limit', 'update', 'insert', 'gte', 'lt', 'contains'];
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
  assert.match(plan.summary, /No inbound events dropped \(yesterday\)/);
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
  assert.match(sticker.summary, /3 inbound dropped unanswered \(yesterday\): sticker ×3/);

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
  assert.match(planDigest([], CLEAN).summary, /No public comments capped \(yesterday\)/);
});

// Total and distinct posts answer different questions. Six on ONE post is the cap working
// as designed — one public answer under a post is the whole rule. Six across six posts is
// six conversations the wall never got, and only the second argues for a higher cap.
test('capped counts name the posts as well as the comments', () => {
  assert.equal(
    cappedLine({ total: 6, posts: 1, unavailable: false }),
    '6 public comments silenced by the per-post cap (yesterday), across 1 post',
  );
  assert.equal(
    cappedLine({ total: 6, posts: 6, unavailable: false }),
    '6 public comments silenced by the per-post cap (yesterday), across 6 posts',
  );
  assert.equal(
    cappedLine({ total: 1, posts: 1, unavailable: false }),
    '1 public comment silenced by the per-post cap (yesterday), across 1 post',
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
  assert.match(planDigest([], CLEAN).summary, /No shadow drafts lost \(yesterday\)/);
  const plan = planDigest([], {
    ...CLEAN,
    lostDrafts: { total: 29, latest: 'Inbound event 737: the shadow draft was lost after 3 deliveries (worker.reception_retry — canned_stale: …).', unavailable: false },
  });
  assert.match(plan.summary, /29 shadow drafts lost \(yesterday\), every customer answered by the Page/);
  assert.match(plan.summary, /canned_stale/, 'the reason is what tells the founder to republish');
});

test('an unreadable lost-draft count prints UNREADABLE, never zero', () => {
  assert.equal(lostDraftsLine({ total: 0, latest: null, unavailable: true }),
    'shadow drafts lost (yesterday): UNREADABLE — alerts could not be counted');
});

// --- the flaw report (D-120) --------------------------------------------------

test('DONE-TEST: THE FLAW REPORT GOES OUT AS ITS OWN MESSAGE AFTER THE DIGEST, AND A BROKEN ONE SAYS SO', async () => {
  const sent: string[] = [];
  const realFetch = globalThis.fetch;
  const env = { ...process.env };
  process.env['ALERTS_ENABLED'] = 'true';
  process.env['TELEGRAM_BOT_TOKEN'] = 'test-token';
  process.env['TELEGRAM_ALERT_CHAT_ID'] = '1';
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    sent.push(String(JSON.parse(init?.body ?? '{}').text));
    return new Response(JSON.stringify({ result: { message_id: sent.length } }), { status: 200 });
  }) as typeof fetch;
  try {
    const ok = await runDigestJob(
      { db: jobDb(), now: NOW, verifySignature: async () => true, flawReport: async () => 'Flaws\n\nMatrix — 1 of 2 replies looks wrong.' },
      { rawBody: '{}', signature: 'sig' },
    );
    assert.equal(ok.status, 200);
    assert.equal(ok.body['flaws_sent'], true);
    assert.equal(sent.length, 2, 'the digest, then the flaw report');
    assert.match(sent[1] ?? '', /^Flaws/);

    sent.length = 0;
    const broken = await runDigestJob(
      { db: jobDb(), now: NOW, verifySignature: async () => true, flawReport: async () => { throw new Error('reset'); } },
      { rawBody: '{}', signature: 'sig' },
    );
    assert.equal(broken.status, 200, 'a broken flaw report never costs the digest');
    assert.match(sent[1] ?? '', /flaw report UNREADABLE — reset/);
  } finally {
    globalThis.fetch = realFetch;
    process.env = env;
  }
});

// The schedule is `5 16 * * *` UTC, 00:05 Ulaanbaatar (D-128 addendum, 2026-09-26); it was
// `0 1 * * *` before. Either way the digest reports the Ulaanbaatar calendar day that has just ended.
test('the report window is the Ulaanbaatar day that just ended, at 00:05 and at 09:00 alike', () => {
  // 2026-09-25 16:05 UTC is 2026-09-26 00:05 in Ulaanbaatar.
  assert.deepEqual(reportWindow(new Date('2026-09-25T16:05:00Z')), {
    date: '2026-09-25', since: '2026-09-24T16:00:00.000Z', until: '2026-09-25T16:00:00.000Z',
  });
  // The old 01:00 UTC run (09:00 Ulaanbaatar on the 26th) reports the same day.
  assert.equal(reportWindow(new Date('2026-09-26T01:00:00Z')).date, '2026-09-25');
  // One minute before local midnight is still the day before.
  assert.equal(reportWindow(new Date('2026-09-25T15:59:00Z')).date, '2026-09-24');
});

// ═══ D-128: the credential warning is shown, and the merged daily report ═══════════════

const WARN_ROW = {
  id: 11, tenant_id: 't-1', severity: 'warn', kind: 'secret.expiring',
  dedup_key: 'secret_expiring:t-1:page_token:data_access_expires_at:warn',
  body: 'Credential page_token for tenant t-1: data access lapses in 24 day(s). Re-authorize and re-seal before then.',
  at: '2026-09-10T00:00:00Z', notified_at: null,
};

test('DONE-TEST: THE 30-DAY CREDENTIAL WARNING IS IN THE DIGEST — written AND shown', () => {
  // Until 2026-09-25 it was a `daily` row routed to a digest that lists only on_change
  // episodes, so it was recorded and shown to nobody (the inventory, B9). As an on_change
  // episode it is an open condition every morning until the credential is re-sealed.
  const plan = planDigest([episode({
    id: 11, severity: 'warn', kind: 'secret.expiring', dedupKey: WARN_ROW.dedup_key, body: WARN_ROW.body,
    at: new Date(WARN_ROW.at), notifiedAt: null,
  })], CLEAN);
  assert.match(plan.summary, /1 open condition/);
  assert.match(plan.summary, /🟠 secret\.expiring · 4d/);
  assert.match(plan.summary, /data access lapses in 24 day\(s\)/);
  assert.equal(plan.escalate.length, 0, 'a warning never re-escalates');
});

/** Every Telegram send, captured; and a run's env restored afterwards. */
async function withTelegram<T>(
  env: Record<string, string | undefined>,
  body: (sent: string[]) => Promise<T>,
  fail: (n: number) => boolean = () => false,
): Promise<T> {
  const sent: string[] = [];
  const realFetch = globalThis.fetch;
  const saved = { ...process.env };
  process.env['ALERTS_ENABLED'] = 'true';
  process.env['TELEGRAM_BOT_TOKEN'] = 'test-token';
  process.env['TELEGRAM_ALERT_CHAT_ID'] = '1';
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
    if (!String(url).startsWith('https://api.telegram.org/')) throw new Error(`unexpected fetch ${String(url)}`);
    sent.push(String(JSON.parse(init?.body ?? '{}').text));
    if (fail(sent.length)) return new Response('no', { status: 500 });
    return new Response(JSON.stringify({ result: { message_id: sent.length } }), { status: 200 });
  }) as typeof fetch;
  try {
    return await body(sent);
  } finally {
    globalThis.fetch = realFetch;
    process.env = saved;
  }
}

/**
 * An `alerts` table that answers each of the digest's reads by what it filters on, and
 * records every read and write. `open` answers the episode read, `yesterday` the section-C
 * read, `lost` the draft-lost count.
 */
function reportDb(over: { open?: unknown[]; yesterday?: unknown[]; yesterdayError?: string; lost?: unknown[] } = {}) {
  const reads: string[][] = [];
  const updates: { patch: Record<string, unknown>; filters: string[] }[] = [];
  const from = (table: string) => {
    const filters: string[] = [];
    let patch: Record<string, unknown> | null = null;
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'neq', 'is', 'like', 'in', 'order', 'limit', 'gte', 'lt', 'contains']) {
      chain[m] = (...args: unknown[]) => { filters.push(`${m}:${args.map((a) => JSON.stringify(a)).join(',')}`); return chain; };
    }
    chain['update'] = (p: Record<string, unknown>) => { patch = p; return chain; };
    chain['then'] = (res: (v: unknown) => unknown) => {
      if (patch !== null) { updates.push({ patch, filters }); return res({ data: null, error: null }); }
      if (table === 'alerts') reads.push(filters);
      const has = (f: string) => filters.includes(f);
      if (table === 'channel_health') return res({ data: [{ observed_at: RAN.toISOString() }], error: null });
      if (table !== 'alerts') return res({ data: [], error: null });
      if (has('eq:"route","digest"')) {
        return res(over.yesterdayError === undefined
          ? { data: over.yesterday ?? [], error: null }
          : { data: null, error: { message: over.yesterdayError } });
      }
      if (has(`eq:"kind","${'mirror.draft_lost'}"`)) return res({ data: over.lost ?? [], error: null });
      return res({ data: over.open ?? [], error: null });
    };
    return chain;
  };
  return { db: { from } as never, reads, updates };
}

const STALE_CRITICAL = {
  id: 5, tenant_id: 't-1', severity: 'critical', kind: 'channel.no_messages',
  dedup_key: 'channel_silence:ch-1:no_messages', body: 'Page 1: no messages for 9h',
  at: '2026-09-09T00:00:00Z', notified_at: '2026-09-09T00:00:00Z',
};
const FLAWS = async () => 'Flaws\n\nMatrix — 2026-09-13: 1 of 2 replies looks wrong.';
const APP_OK = async () => ({ ok: true as const, text: 'DalaTech — лидүүд (өчигдөр)\nШинэ: 1' });

test('DONE-TEST: WITHOUT DAILY_REPORT_V2 NOTHING CHANGES — summary, STILL OPEN, flaws, three messages', async () => {
  await withTelegram({ DAILY_REPORT_V2: undefined, DAILY_REPORT_SECRET: 'x' }, async (sent) => {
    let appAsked = false;
    const { db, updates } = reportDb({ open: [STALE_CRITICAL] });
    const r = await runDigestJob({
      db, now: NOW, verifySignature: async () => true, flawReport: FLAWS,
      appSection: async () => { appAsked = true; return { ok: true, text: 'x' }; },
    }, { rawBody: '{}', signature: 'sig' });
    assert.equal(r.status, 200);
    assert.equal(sent.length, 3, sent.join('\n---\n'));
    assert.match(sent[0] ?? '', /^Dala AI — /);
    assert.match(sent[1] ?? '', /^🔴 STILL OPEN after 5d: /);
    assert.match(sent[2] ?? '', /^Flaws/);
    assert.equal(appAsked, false, 'the app section is not fetched without the flag');
    assert.deepEqual(Object.keys(r.body).sort(), ['escalated', 'flaws_sent', 'open', 'sent']);
    assert.equal(updates.filter((u) => 'notified_at' in u.patch).length, 1);
  });
});

test('DONE-TEST: UNDER DAILY_REPORT_V2 IT IS ONE MESSAGE — app, digest with STILL OPEN, Yesterday, flaws', async () => {
  await withTelegram({ DAILY_REPORT_V2: 'true' }, async (sent) => {
    const { db, updates } = reportDb({
      open: [STALE_CRITICAL, WARN_ROW],
      yesterday: [
        { kind: 'model.cache_cold_run', severity: 'warn', body: 'second cold run', at: '2026-09-13T10:00:00Z' },
        { kind: 'model.cache_cold_run', severity: 'warn', body: 'first cold run', at: '2026-09-13T03:00:00Z' },
        { kind: 'channel.recovered', severity: 'info', body: 'Page 1: recovered — channel.no_messages is clear.', at: '2026-09-13T08:00:00Z' },
      ],
    });
    const r = await runDigestJob(
      { db, now: NOW, verifySignature: async () => true, flawReport: FLAWS, appSection: APP_OK },
      { rawBody: '{}', signature: 'sig' },
    );
    assert.equal(r.status, 200);
    assert.equal(sent.length, 1, 'one report, not four kinds of message');
    const text = sent[0] ?? '';
    const parts = text.split(SECTION_JOIN);
    assert.equal(parts.length, 4, text);
    assert.match(parts[0] ?? '', /^DalaTech — лидүүд \(өчигдөр\)/);
    assert.match(parts[1] ?? '', /^Dala AI — /);
    assert.match(parts[1] ?? '', /🟠 secret\.expiring/, 'the credential warning is an open condition');
    assert.match(parts[1] ?? '', /\n🔴 STILL OPEN after 5d: Page 1: no messages for 9h$/, 'escalation is a line in B');
    assert.match(parts[2] ?? '', /^Yesterday \(2026-09-13\)/);
    assert.match(parts[2] ?? '', /🟠 model\.cache_cold_run ×2 — second cold run/);
    assert.match(parts[2] ?? '', /ℹ️ channel\.recovered ×1 — Page 1: recovered/);
    assert.match(parts[3] ?? '', /^Flaws/);
    assert.doesNotMatch(text, /\(1\/1\)/, 'no part counter on a report that fits');
    // The three-day cadence is unchanged: the escalated row's clock moves when B is delivered.
    const stamp = updates.find((u) => 'notified_at' in u.patch);
    assert.ok(stamp?.filters.some((f) => f === 'in:"id",[5]'), JSON.stringify(stamp));
    assert.equal(r.body['escalated'], 1);
    assert.equal(r.body['messages'], 1);
    assert.equal(r.body['app_section'], 'ok');
    assert.equal(r.body['sent'], true);
  });
});

test('DONE-TEST: «Yesterday» reads only demoted EVENTS of the report day, never episodes or lost drafts', async () => {
  await withTelegram({ DAILY_REPORT_V2: 'true' }, async () => {
    const { db, reads } = reportDb();
    await runDigestJob({ db, now: NOW, verifySignature: async () => true, flawReport: FLAWS, appSection: APP_OK },
      { rawBody: '{}', signature: 'sig' });
    const q = reads.find((f) => f.includes('eq:"route","digest"'));
    assert.ok(q, 'section C read the alerts table');
    assert.ok(q.includes('neq:"repeat_policy","on_change"'), 'episodes are section B\'s');
    assert.ok(q.includes('neq:"kind","mirror.draft_lost"'), 'lost drafts have their own counted line');
    const w = reportWindow(NOW);
    assert.ok(q.includes(`gte:"at","${w.since}"`) && q.includes(`lt:"at","${w.until}"`), JSON.stringify(q));
  });
});

test('an unreadable «Yesterday» says UNREADABLE and the report still goes', async () => {
  await withTelegram({ DAILY_REPORT_V2: 'true' }, async (sent) => {
    const { db } = reportDb({ yesterdayError: 'connection reset' });
    const r = await runDigestJob({ db, now: NOW, verifySignature: async () => true, flawReport: FLAWS, appSection: APP_OK },
      { rawBody: '{}', signature: 'sig' });
    assert.equal(r.status, 200);
    assert.match(sent[0] ?? '', /Yesterday \(2026-09-13\): UNREADABLE — alerts could not be read \(connection reset\)/);
  });
});

test('DONE-TEST: an app section that could not be read is a LINE in the report, never an absence', async () => {
  await withTelegram({ DAILY_REPORT_V2: 'true', DAILY_REPORT_SECRET: undefined }, async (sent) => {
    const { db } = reportDb();
    // No `appSection` injected: the real fetcher runs, finds no secret, and says so.
    const r = await runDigestJob({ db, now: NOW, verifySignature: async () => true, flawReport: FLAWS },
      { rawBody: '{}', signature: 'sig' });
    assert.equal(r.body['app_section'], 'unreadable');
    assert.match(sent[0] ?? '', /^DalaTech app section UNREADABLE — DAILY_REPORT_SECRET is not set/);
  });
});

test('a report part that fails to send stamps NO escalation, so it is due again tomorrow', async () => {
  await withTelegram({ DAILY_REPORT_V2: 'true' }, async (sent) => {
    const { db, updates } = reportDb({ open: [STALE_CRITICAL] });
    const r = await runDigestJob({ db, now: NOW, verifySignature: async () => true, flawReport: FLAWS, appSection: APP_OK },
      { rawBody: '{}', signature: 'sig' });
    assert.equal(sent.length, 1);
    assert.equal(r.body['sent'], false);
    assert.equal(r.body['escalated'], 0);
    assert.match(String(r.body['send_detail']), /telegram 500/);
    assert.equal(updates.filter((u) => 'notified_at' in u.patch).length, 0);
  }, () => true);
});

// --- section C, pure ---------------------------------------------------------

test('«Yesterday» groups by kind: mark, count, and the LATEST body, clipped to 160', () => {
  const long = 'x'.repeat(400);
  const text = renderYesterday({ ok: true, truncated: false, rows: [
    { kind: 'webhook.requeued', severity: 'warn', body: 'old', at: new Date('2026-09-13T01:00:00Z') },
    { kind: 'webhook.requeued', severity: 'warn', body: long, at: new Date('2026-09-13T05:00:00Z') },
    { kind: 'privacy.erasure_requested', severity: 'warn', body: 'Data deletion request(s) received today', at: new Date('2026-09-13T02:00:00Z') },
  ] }, '2026-09-13');
  const lines = text.split('\n');
  assert.equal(lines[0], 'Yesterday (2026-09-13) — 3 recorded for this report, not paged:');
  assert.equal(lines[1], `🟠 webhook.requeued ×2 — ${'x'.repeat(159)}…`, 'count first, then the newest body');
  assert.equal(lines[2], '🟠 privacy.erasure_requested ×1 — Data deletion request(s) received today');
});

test('an empty «Yesterday» says so, and a truncated one says it was cut', () => {
  assert.equal(renderYesterday({ ok: true, rows: [], truncated: false }, '2026-09-13'),
    'Yesterday (2026-09-13): nothing was held back for this report.');
  const cut = renderYesterday({ ok: true, truncated: true, rows: [
    { kind: 'k', severity: 'info', body: 'b', at: new Date('2026-09-13T01:00:00Z') },
  ] }, '2026-09-13');
  assert.match(cut, /only the newest 1 rows were read/);
});

// --- the layout, pure ----------------------------------------------------------

const sec = (name: ReportSection['name'], lines: number, width = 60): ReportSection =>
  ({ name, text: Array.from({ length: lines }, (_, i) => `${name} line ${i} ${'ж'.repeat(width)}`).join('\n') });

test('a report that fits is one message with no part counter', () => {
  const out = composeDailyReport([sec('app', 2), sec('digest', 2), sec('yesterday', 1), sec('flaws', 3)]);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.text.split(SECTION_JOIN).length, 4);
});

test('DONE-TEST: A LONG REPORT SPLITS AT SECTION BOUNDARIES, (1/2) (2/2), EVERY PART UNDER THE LIMIT', () => {
  const sections = [sec('app', 20), sec('digest', 20), sec('yesterday', 20), sec('flaws', 20)];
  const out = composeDailyReport(sections);
  assert.ok(out.length >= 2);
  out.forEach((m, i) => {
    assert.ok(m.text.length <= DAILY_REPORT_LIMIT, `part ${i + 1} is ${m.text.length}`);
    assert.ok(m.text.endsWith(`\n(${i + 1}/${out.length})`), m.text.slice(-12));
  });
  // Every original line survives whole, in order: nothing was cut inside a line.
  const body = out.map((m) => m.text.replace(/\n\(\d+\/\d+\)$/, '')).join(SECTION_JOIN);
  const want = sections.flatMap((s) => s.text.split('\n'));
  assert.deepEqual(body.split('\n').filter((l) => want.includes(l)), want);
  // Each section fits a message on its own here, so every part must START at a section's
  // first line: the cut fell on a boundary, and no section is spread across two parts.
  for (const m of out) assert.ok(m.text.startsWith(`${m.sections[0]} line 0 `), m.text.slice(0, 30));
  assert.deepEqual(out.flatMap((m) => m.sections), ['app', 'digest', 'yesterday', 'flaws']);
});

test('a single section longer than a message is cut between LINES, never inside one', () => {
  const big = sec('flaws', 120);
  const out = composeDailyReport([sec('app', 1), big]);
  assert.ok(out.length >= 3);
  for (const m of out) assert.ok(m.text.length <= DAILY_REPORT_LIMIT);
  const lines = out.flatMap((m) => m.text.replace(/\n\(\d+\/\d+\)$/, '').split('\n'));
  for (const l of big.text.split('\n')) assert.ok(lines.includes(l), `line lost or cut: ${l.slice(0, 20)}`);
});

// --- section A, the fetch --------------------------------------------------------

async function appWith(env: Record<string, string | undefined>, impl: typeof fetch) {
  const saved = { ...process.env };
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fetchAppSection(impl); } finally { process.env = saved; }
}

const SECRET = 'CANARY-daily-report-secret';

test('DONE-TEST: the app section is fetched with the bearer, no-store, and returns its text verbatim (NFC)', async () => {
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  const decomposed = 'Шинэ: 1 · Сонгосон: 1 — Й'.normalize('NFD');
  const r = await appWith({ DAILY_REPORT_SECRET: SECRET, DAILY_REPORT_SECTION_URL: undefined }, (async (url: unknown, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true, generatedAt: '2026-09-26T00:59:00Z', text: decomposed, counts: {} }), { status: 200 });
  }) as typeof fetch);
  assert.deepEqual(r, { ok: true, text: decomposed.normalize('NFC') });
  assert.equal(seen[0]?.url, DEFAULT_APP_SECTION_URL);
  assert.equal((seen[0]?.init?.headers as Record<string, string>)['authorization'], `Bearer ${SECRET}`);
  assert.equal(seen[0]?.init?.cache, 'no-store');
  assert.ok(seen[0]?.init?.signal instanceof AbortSignal, 'bounded by a timeout');
});

test('DAILY_REPORT_SECTION_URL overrides the endpoint', async () => {
  let asked = '';
  await appWith({ DAILY_REPORT_SECRET: SECRET, DAILY_REPORT_SECTION_URL: 'https://staging.example/section' }, (async (url: unknown) => {
    asked = String(url);
    return new Response(JSON.stringify({ ok: true, text: 't' }), { status: 200 });
  }) as typeof fetch);
  assert.equal(asked, 'https://staging.example/section');
});

test('DONE-TEST: EVERY FAILURE IS AN UNREADABLE LINE WITH ITS REASON, AND NONE CARRIES THE SECRET', async () => {
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const cases: [string, Record<string, string | undefined>, typeof fetch][] = [
    ['DAILY_REPORT_SECRET is not set', { DAILY_REPORT_SECRET: undefined }, (async () => { throw new Error('must not be called'); }) as typeof fetch],
    ['HTTP 401', { DAILY_REPORT_SECRET: SECRET }, (async () => new Response('no', { status: 401 })) as typeof fetch],
    ['HTTP 302', { DAILY_REPORT_SECRET: SECRET }, (async () => new Response(null, { status: 302, headers: { location: 'https://x' } })) as typeof fetch],
    ['no answer within 8s', { DAILY_REPORT_SECRET: SECRET }, (async () => { throw timeout; }) as typeof fetch],
    ['the response was not JSON', { DAILY_REPORT_SECRET: SECRET }, (async () => new Response('<html>', { status: 200 })) as typeof fetch],
    ['the response was not { ok: true, text }', { DAILY_REPORT_SECRET: SECRET }, (async () => new Response(JSON.stringify({ ok: false, text: 'x' }), { status: 200 })) as typeof fetch],
    ['the response was not { ok: true, text }', { DAILY_REPORT_SECRET: SECRET }, (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch],
    ['the section text was empty', { DAILY_REPORT_SECRET: SECRET }, (async () => new Response(JSON.stringify({ ok: true, text: '  ' }), { status: 200 })) as typeof fetch],
    ['request failed (ECONNREFUSED)', { DAILY_REPORT_SECRET: SECRET }, (async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }) as typeof fetch],
  ];
  for (const [reason, env, impl] of cases) {
    const r = await appWith(env, impl);
    assert.equal(r.ok, false, reason);
    assert.equal(r.text, `DalaTech app section UNREADABLE — ${reason}`);
    assert.ok(!r.text.includes('CANARY'), 'the secret never reaches the report');
  }
});
