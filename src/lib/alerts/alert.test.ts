import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dailyReportV2, openEpisodes, quietRoute, raiseAlert, resolveEpisodes, resolveOpenAlerts, spendDedupKey,
} from './alert.ts';

/** In-memory alerts table with the dedup semantics the real one has. */
function stubDb() {
  const rows: Array<{ id: number; dedup_key: string; delivered: boolean }> = [];
  let nextId = 1;
  const db = {
    from: () => {
      const chain: Record<string, unknown> = {};
      let pendingKey: string | null = null;
      let inserted: { id: number } | null = null;
      chain['select'] = () => chain;
      chain['eq'] = (_col: string, val: string) => { pendingKey = val; return chain; };
      chain['limit'] = () => chain;
      chain['update'] = () => chain;
      chain['insert'] = (row: { dedup_key: string }) => {
        if (rows.some((r) => r.dedup_key === row.dedup_key)) { inserted = null; return chain; }
        const created = { id: nextId++, dedup_key: row.dedup_key, delivered: false };
        rows.push(created);
        inserted = { id: created.id };
        return chain;
      };
      chain['maybeSingle'] = async () => {
        if (inserted !== null) return { data: inserted, error: null };
        if (pendingKey !== null) {
          const found = rows.find((r) => r.dedup_key === pendingKey);
          return { data: found ? { id: found.id } : null, error: null };
        }
        return { data: null, error: null };
      };
      chain['then'] = (res: (v: unknown) => unknown) => res({ error: null });
      return chain;
    },
  } as never;
  return { db, rows };
}

test('THE DONE-TEST: a tripped ceiling fires exactly ONE alert, not five hundred', async () => {
  // V1.md item 2.3. A tripped ceiling is hit by every subsequent inbound message, so a
  // naive alert produces one notification per message — which trains the founder to
  // ignore the channel precisely when it matters most.
  process.env['ALERTS_ENABLED'] = 'false';
  const { db, rows } = stubDb();
  const key = spendDedupKey('t-1', 'reception', '2026-09-02', '100pct');

  const outcomes: string[] = [];
  for (let i = 0; i < 500; i += 1) {
    const res = await raiseAlert(db, {
      tenantId: 't-1', severity: 'critical', kind: 'spend.ceiling_reached',
      dedupKey: key, body: 'Reception daily ceiling reached',
    });
    outcomes.push(res.outcome);
  }

  assert.equal(rows.length, 1, 'exactly one alert row for 500 occurrences');
  assert.equal(outcomes.filter((o) => o !== 'suppressed_duplicate').length, 1);
  assert.equal(outcomes[0], 'recorded_undelivered');
  assert.ok(outcomes.slice(1).every((o) => o === 'suppressed_duplicate'));
});

test('the same ceiling TOMORROW is a new alert, not a suppressed one', async () => {
  // The period is in the dedup key on purpose. Without it, a ceiling hit once would be
  // silent forever after.
  process.env['ALERTS_ENABLED'] = 'false';
  const { db, rows } = stubDb();
  for (const day of ['2026-09-02', '2026-09-03']) {
    await raiseAlert(db, {
      tenantId: 't-1', severity: 'critical', kind: 'spend.ceiling_reached',
      dedupKey: spendDedupKey('t-1', 'reception', day, '100pct'), body: 'ceiling',
    });
  }
  assert.equal(rows.length, 2);
});

test('different tenants hitting the same threshold are separate alerts', async () => {
  process.env['ALERTS_ENABLED'] = 'false';
  const { db, rows } = stubDb();
  for (const tenant of ['t-1', 't-2']) {
    await raiseAlert(db, {
      tenantId: tenant, severity: 'warn', kind: 'spend.threshold',
      dedupKey: spendDedupKey(tenant, 'reception', '2026-09-02', '80pct'), body: '80%',
    });
  }
  assert.equal(rows.length, 2);
});

test('a suppressed send still records the row — detection is never lost', async () => {
  // ALERTS_ENABLED=false suppresses the SEND, never the row. A test can therefore still
  // prove the condition was detected, and a delivery failure stays visible as
  // delivered=false rather than vanishing.
  process.env['ALERTS_ENABLED'] = 'false';
  const { db, rows } = stubDb();
  const res = await raiseAlert(db, {
    tenantId: 't-1', severity: 'info', kind: 'x', dedupKey: 'k', body: 'b',
  });
  assert.equal(res.outcome, 'recorded_undelivered');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.delivered, false);
});

// --------------------------------------------------------------------------
// 0025: route and repeat_policy.
// --------------------------------------------------------------------------

type Row = {
  id: number; dedup_key: string; kind: string; severity: string; body: string;
  route: string; repeat_policy: string; resolved_at: string | null;
  notified_at: string | null; at: string; tenant_id: string | null; delivered: boolean;
};

/**
 * An alerts table that models the columns `on_change` actually turns on.
 *
 * Deliberately a second stub rather than an extension of the one above: that one exists to
 * prove the 500-messages property and reads better for being about nothing else.
 */
function episodeDb() {
  const rows: Row[] = [];
  let nextId = 1;
  const db = {
    from: () => {
      const chain: Record<string, unknown> = {};
      let key: string | null = null;
      let prefix: string | null = null;
      let openOnly = false;
      let repeat: string | null = null;
      let ids: number[] | null = null;
      let keys: string[] | null = null;
      let inserted: { id: number } | null = null;
      let patch: Record<string, unknown> | null = null;

      const matches = (r: Row): boolean =>
        (key === null || r.dedup_key === key)
        && (prefix === null || r.dedup_key.startsWith(prefix))
        && (!openOnly || r.resolved_at === null)
        && (repeat === null || r.repeat_policy === repeat)
        && (ids === null || ids.includes(r.id))
        && (keys === null || keys.includes(r.dedup_key));

      chain['select'] = () => chain;
      chain['order'] = () => chain;
      chain['limit'] = () => chain;
      chain['eq'] = (col: string, val: string) => {
        if (col === 'dedup_key') key = val;
        if (col === 'repeat_policy') repeat = val;
        if (col === 'id') ids = [Number(val)];
        return chain;
      };
      chain['is'] = (col: string, val: unknown) => {
        if (col === 'resolved_at' && val === null) openOnly = true;
        return chain;
      };
      chain['like'] = (_col: string, val: string) => { prefix = val.replace(/%$/, ''); return chain; };
      chain['in'] = (col: string, vals: readonly unknown[]) => {
        if (col === 'dedup_key') keys = vals.map(String); else ids = vals.map(Number);
        return chain;
      };
      chain['insert'] = (row: Record<string, unknown>) => {
        const created: Row = {
          id: nextId++, dedup_key: String(row['dedup_key']), kind: String(row['kind']),
          severity: String(row['severity']), body: String(row['body']),
          route: String(row['route']), repeat_policy: String(row['repeat_policy']),
          resolved_at: null, notified_at: null, at: new Date().toISOString(),
          tenant_id: row['tenant_id'] === null ? null : String(row['tenant_id']), delivered: false,
        };
        rows.push(created);
        inserted = { id: created.id };
        return chain;
      };
      chain['update'] = (p: Record<string, unknown>) => { patch = p; return chain; };
      chain['maybeSingle'] = async () => {
        if (inserted !== null) return { data: inserted, error: null };
        const found = rows.find(matches);
        return { data: found ? { id: found.id } : null, error: null };
      };
      chain['then'] = (res: (v: unknown) => unknown) => {
        if (patch !== null) {
          const hit = rows.filter(matches);
          for (const r of hit) {
            if ('resolved_at' in patch) r.resolved_at = String(patch['resolved_at']);
            if ('notified_at' in patch) r.notified_at = String(patch['notified_at']);
            if ('delivered' in patch) r.delivered = patch['delivered'] === true;
          }
          // `update(…).select('id')` answers with the rows it changed, as PostgREST does.
          return res({ data: hit.map((r) => ({ id: r.id })), error: null });
        }
        return res({ data: rows.filter(matches), error: null });
      };
      return chain;
    },
  } as never;
  return { db, rows };
}

const EPISODE = {
  tenantId: 't-1' as string | null,
  severity: 'critical' as const,
  kind: 'channel.no_webhooks',
  dedupKey: 'channel_silence:ch-1:no_webhooks',
  body: 'Page 1: nothing has arrived',
  route: 'now' as const,
  repeat: 'on_change' as const,
};

test('DONE-TEST: AN ON_CHANGE EPISODE SPEAKS ONCE AND THEN HOLDS ITS TONGUE', async () => {
  // The measured failure, at the layer that decides it. On 2026-09-14 one unchanged
  // condition had produced a critical Telegram every morning for six days — ten of the
  // eleven rows the table then held — because the dedup key carried the date. Eleven runs
  // of an unchanged condition must now produce exactly one row.
  process.env['ALERTS_ENABLED'] = 'false';
  const { db, rows } = episodeDb();
  const outcomes: string[] = [];
  for (let i = 0; i < 11; i += 1) outcomes.push((await raiseAlert(db, EPISODE)).outcome);

  assert.equal(rows.length, 1, 'one episode, one row');
  assert.equal(outcomes[0], 'recorded_undelivered');
  assert.ok(outcomes.slice(1).every((o) => o === 'suppressed_duplicate'), JSON.stringify(outcomes));
});

test('DONE-TEST: and it speaks AGAIN once the episode is resolved', async () => {
  // The other half, and the reason `on_change` is not just `once`. A channel that dies,
  // recovers and dies again is two outages. Suppressing the second for ever would be the
  // silence D-062 is about, built deliberately.
  process.env['ALERTS_ENABLED'] = 'false';
  const { db, rows } = episodeDb();
  await raiseAlert(db, EPISODE);

  const closed = await resolveOpenAlerts(db, { keyPrefix: 'channel_silence:ch-1:', now: new Date('2026-09-14T00:00:00Z') });
  assert.equal(closed.ok && closed.resolved.length, 1);
  assert.equal(rows[0]?.resolved_at, '2026-09-14T00:00:00.000Z');

  assert.equal((await raiseAlert(db, EPISODE)).outcome, 'recorded_undelivered');
  assert.equal(rows.length, 2, 'a second outage is a second episode');
});

test('resolveOpenAlerts keeps the episode the caller just raised', async () => {
  // A degrade closes the OTHER states and keeps this one; without exceptKey it would close
  // the alert it is in the middle of raising.
  process.env['ALERTS_ENABLED'] = 'false';
  const { db, rows } = episodeDb();
  await raiseAlert(db, { ...EPISODE, dedupKey: 'channel_silence:ch-1:no_messages', kind: 'channel.no_messages' });
  await raiseAlert(db, EPISODE);

  const closed = await resolveOpenAlerts(db, {
    keyPrefix: 'channel_silence:ch-1:',
    exceptKey: EPISODE.dedupKey,
    now: new Date('2026-09-14T00:00:00Z'),
  });
  assert.ok(closed.ok);
  assert.deepEqual(closed.ok ? closed.resolved.map((a) => a.kind) : [], ['channel.no_messages'],
    'exactly the superseded one');
  assert.equal(rows.find((r) => r.dedup_key === EPISODE.dedupKey)?.resolved_at, null, 'the current one stays open');
});

test('a once row is an EVENT and is never an open episode', async () => {
  // `resolved_at` is null on it for ever, because nothing resolves an event. If the digest
  // did not filter on repeat_policy it would list the entire history of the table, which is
  // the daily repeat again wearing the fix's clothes.
  process.env['ALERTS_ENABLED'] = 'false';
  const { db } = episodeDb();
  await raiseAlert(db, {
    tenantId: null, severity: 'info', kind: 'channel.recovered',
    dedupKey: 'channel_recovered:42', body: 'recovered', route: 'now', repeat: 'once',
  });
  const open = await openEpisodes(db);
  assert.equal(open.ok && open.open.length, 0);
});

test('DONE-TEST: a digest route records the row and sends NOTHING', async () => {
  // And says so as its own outcome. Reporting it as `recorded_undelivered` would put a
  // deliberate choice in the same bucket as a Telegram failure.
  delete process.env['ALERTS_ENABLED'];
  const { db, rows } = episodeDb();
  const res = await raiseAlert(db, { ...EPISODE, route: 'digest' });
  assert.equal(res.outcome, 'recorded_for_digest');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.notified_at, null, 'nobody has been told, so the 3-day clock runs from `at`');
  process.env['ALERTS_ENABLED'] = 'false';
});

// --------------------------------------------------------------------------
// D-128: once-ever criticals become episodes, and quiet warnings can wait for 09:00.
// --------------------------------------------------------------------------

/** A legacy row, as `0025`'s default and every pre-2026-09-25 caller left it. */
function legacyRow(rows: Row[], over: Partial<Row>): void {
  rows.push({
    id: 900 + rows.length, dedup_key: 'model_not_found:claude-sonnet-5', kind: 'model.not_found',
    severity: 'critical', body: 'old', route: 'now', repeat_policy: 'daily', resolved_at: null,
    notified_at: null, at: '2026-09-01T00:00:00.000Z', tenant_id: null, delivered: true, ...over,
  });
}

test('DONE-TEST: A LEGACY EVENT ROW UNDER THE SAME KEY NEVER GAGS AN ON_CHANGE EPISODE', async () => {
  // `model_not_found:{id}` was a `daily` row under a dateless key. Its `resolved_at` is null
  // for ever, because nothing resolves an event — so an `on_change` check that did not read
  // the policy would find it "open" and stay silent for good: the once-ever bug, surviving
  // the fix through the rows it left behind.
  process.env['ALERTS_ENABLED'] = 'false';
  const { db, rows } = episodeDb();
  legacyRow(rows, {});
  const res = await raiseAlert(db, {
    tenantId: null, severity: 'critical', kind: 'model.not_found',
    dedupKey: 'model_not_found:claude-sonnet-5', body: 'new', route: 'now', repeat: 'on_change',
  });
  assert.equal(res.outcome, 'recorded_undelivered');
  assert.equal(rows.length, 2);
  assert.equal(rows[1]?.repeat_policy, 'on_change');
});

test('DONE-TEST: AN ON_CHANGE CRITICAL ROUTED NOW PAGES AT OPEN, HOLDS, AND PAGES AGAIN AFTER A RESOLVE', async () => {
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
    const { db, rows } = episodeDb();
    const input = {
      tenantId: null, severity: 'critical' as const, kind: 'model.not_found',
      dedupKey: 'model_not_found:claude-sonnet-5', body: 'claude-sonnet-5 returned 404',
      route: 'now' as const, repeat: 'on_change' as const,
    };
    assert.equal((await raiseAlert(db, input)).outcome, 'sent');
    assert.equal(sent.length, 1, 'the first occurrence pages immediately');
    assert.match(sent[0] ?? '', /^🔴 claude-sonnet-5 returned 404/);
    assert.ok(rows[0]?.notified_at !== null, 'the three-day clock starts at the page');

    assert.equal((await raiseAlert(db, input)).outcome, 'suppressed_duplicate');
    assert.equal(sent.length, 1, 'while it holds, it is silent');

    const closed = await resolveEpisodes(db, { dedupKeys: [input.dedupKey], now: new Date('2026-09-25T00:00:00Z') });
    assert.deepEqual(closed, { ok: true, resolved: 1 });

    assert.equal((await raiseAlert(db, input)).outcome, 'sent');
    assert.equal(sent.length, 2, 'a recurrence after recovery is a new page');
  } finally {
    globalThis.fetch = realFetch;
    process.env = env;
  }
});

test('resolveEpisodes closes only OPEN ON_CHANGE rows under exactly the given keys', async () => {
  process.env['ALERTS_ENABLED'] = 'false';
  const { db, rows } = episodeDb();
  await raiseAlert(db, { ...EPISODE, dedupKey: 'model_not_found:a', kind: 'model.not_found' });
  await raiseAlert(db, { ...EPISODE, dedupKey: 'model_not_found:ab', kind: 'model.not_found' });
  legacyRow(rows, { dedup_key: 'model_not_found:a' });

  const r = await resolveEpisodes(db, { dedupKeys: ['model_not_found:a'], now: new Date('2026-09-25T00:00:00Z') });
  assert.deepEqual(r, { ok: true, resolved: 1 });
  assert.equal(rows.find((x) => x.dedup_key === 'model_not_found:a' && x.repeat_policy === 'on_change')?.resolved_at,
    '2026-09-25T00:00:00.000Z');
  assert.equal(rows.find((x) => x.dedup_key === 'model_not_found:ab')?.resolved_at, null, 'exact key, never a prefix');
  assert.equal(rows.find((x) => x.repeat_policy === 'daily')?.resolved_at, null, 'an event is never "resolved"');

  assert.deepEqual(await resolveEpisodes(db, { dedupKeys: [], now: new Date() }), { ok: true, resolved: 0 });
});

test('resolveOpenAlerts keeps EVERY key in exceptKeys', async () => {
  process.env['ALERTS_ENABLED'] = 'false';
  const { db, rows } = episodeDb();
  for (const k of ['secret_expiring:t:page_token:expires_at:warn', 'secret_expiring:t:page_token:data_access_expires_at:critical',
    'secret_expiring:t:page_token:data_access_expires_at:warn']) {
    await raiseAlert(db, { ...EPISODE, kind: 'secret.expiring', dedupKey: k });
  }
  const closed = await resolveOpenAlerts(db, {
    keyPrefix: 'secret_expiring:',
    exceptKeys: ['secret_expiring:t:page_token:expires_at:warn', 'secret_expiring:t:page_token:data_access_expires_at:critical'],
    now: new Date('2026-09-25T00:00:00Z'),
  });
  assert.deepEqual(closed.ok ? closed.resolved.map((a) => a.dedupKey) : null,
    ['secret_expiring:t:page_token:data_access_expires_at:warn']);
  assert.equal(rows.filter((r) => r.resolved_at === null).length, 2);
});

test('DONE-TEST: quietRoute is now unless DAILY_REPORT_V2 is exactly "true"', () => {
  const saved = process.env['DAILY_REPORT_V2'];
  try {
    for (const [v, route] of [[undefined, 'now'], ['', 'now'], ['false', 'now'], ['TRUE', 'now'], ['1', 'now'], ['true', 'digest']] as const) {
      if (v === undefined) delete process.env['DAILY_REPORT_V2']; else process.env['DAILY_REPORT_V2'] = v;
      assert.equal(quietRoute(), route, `DAILY_REPORT_V2=${String(v)}`);
      assert.equal(dailyReportV2(), route === 'digest');
    }
  } finally {
    if (saved === undefined) delete process.env['DAILY_REPORT_V2']; else process.env['DAILY_REPORT_V2'] = saved;
  }
});
