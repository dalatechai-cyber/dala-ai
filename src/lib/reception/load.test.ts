import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadReceptionContext, type TenantSettings } from './load.ts';

const SETTINGS: TenantSettings = { defaultLocale: 'mn-MN', promptCacheMode: '1h' };

const SNAPSHOT = { content_hash: 'h', prompt_stable: 'PREFIX', allowed_numbers: ['33,000'] };

function stubDb(over: Record<string, { data?: unknown; error?: unknown }> = {}) {
  const seen: string[] = [];
  const table = (name: string) => {
    seen.push(name);
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'or', 'limit', 'order', 'gte', 'lte', 'in', 'is']) chain[m] = () => chain;
    chain['maybeSingle'] = async () => {
      if (name === 'tenants') return { data: { live_revision_id: 'rev-1' }, error: null };
      if (name === 'config_snapshots') return over['config_snapshots'] ?? { data: SNAPSHOT, error: null };
      return { data: null, error: null };
    };
    // List reads resolve when awaited directly.
    chain['then'] = (res: (v: unknown) => unknown) =>
      res(over[name] ?? { data: DEFAULTS[name] ?? [], error: null });
    return chain;
  };
  return { seen, db: { from: table } as never };
}

const DEFAULTS: Record<string, unknown[]> = {
  disclosure_rules: [{
    topic_key: 'children_services',
    matcher: { mode: 'contains_stem', stems: ['хүүхэд'] },
    quote_price: false, response_kind: 'refusal_topic', deterministic_shortcircuit: false,
  }],
  out_of_scope_topics: [{
    topic_key: 'health',
    matcher: { mode: 'contains_stem', stems: ['жирэмс'] },
    response_kind: 'refusal_health', deterministic_shortcircuit: false,
  }],
  canned_responses: [{ kind: 'handoff', body: 'Уучлаарай.', reviewed_at: '2026-09-04T00:00:00Z' }],
  tenant_booking: [{ booking_url: 'https://www.matrixecosalon.org/' }],
  services: [{ name: 'CICA' }],
  deterministic_replies: [{
    intent: 'greeting', body: 'Сайн байна уу!', enabled: true,
    match_mode: 'whole_message', stems: ['сайн байна уу'], requires_empty_history: true,
  }],
  business_hours: [{ weekday: 1, opens: '10:00:00', closes: '20:00:00', closed: false }],
  tenant_closures: [{ starts_on: '2026-09-07', ends_on: '2026-09-09', title: 'Наадам', message: 'Амарна.' }],
  forbidden_phrasings: [
    { gate: 'Ш5', stems: ['санаа', 'зоволтгүй'], tenant_id: null },
    { gate: 'Ш5', stems: ['аюулгүй'], tenant_id: 't-1' },
    { gate: null, stems: null, tenant_id: null },
  ],
};

const input = { tenantId: 't-1', channel: 'facebook_page', settings: SETTINGS, localDate: '2026-09-04' };

test('the gate is derived from the response kind, not stored twice', async () => {
  const r = await loadReceptionContext(stubDb().db, input);
  assert.equal(r.ok, true);
  const gates = r.ok ? r.context.rules.map((x) => `${x.topicKey}:${x.gate}`) : [];
  assert.deepEqual(gates, ['children_services:Ш1', 'health:Ш5']);
});

test('out_of_scope topics never license a number, even without a quote_price column', async () => {
  const r = await loadReceptionContext(stubDb().db, input);
  const health = r.ok ? r.context.rules.find((x) => x.topicKey === 'health') : undefined;
  assert.equal(health?.quotePrice, false);
});

test('forbidden phrasings are keyed BY GATE, platform rows and tenant rows together', async () => {
  const r = await loadReceptionContext(stubDb().db, input);
  assert.deepEqual(r.ok && r.context.tenantGuard.forbiddenStemSeqs['Ш5'], [['санаа', 'зоволтгүй'], ['аюулгүй']]);
});

test('A DOCUMENTARY ROW IS SKIPPED, never flattened into another gate', async () => {
  // A phrasing observed but not yet reduced to stems is worth keeping — `rationale`,
  // `observed_at` and `evidence` are the table's other half. Putting it in some gate's
  // list anyway is the flattening §6.7(a) says destroys the per-gate counter.
  const r = await loadReceptionContext(stubDb().db, input);
  const all = r.ok ? Object.values(r.context.tenantGuard.forbiddenStemSeqs).flat() : [];
  assert.equal(all.length, 2, 'the gate-less row contributed nothing');
});

test('an empty stems array is not enforceable and is skipped', async () => {
  const r = await loadReceptionContext(stubDb({ forbidden_phrasings: { data: [{ gate: 'Ш5', stems: [] }] } }).db, input);
  assert.deepEqual(r.ok && r.context.tenantGuard.forbiddenStemSeqs, {});
});

test('the script is derived from the locale — Russian and Mongolian both resolve Cyrillic', async () => {
  const mn = await loadReceptionContext(stubDb().db, input);
  assert.equal(mn.ok && mn.context.tenantGuard.primaryScript, 'Cyrillic');
  const ru = await loadReceptionContext(stubDb().db, { ...input, settings: { ...SETTINGS, defaultLocale: 'ru-RU' } });
  assert.equal(ru.ok && ru.context.tenantGuard.primaryScript, 'Cyrillic');
  const en = await loadReceptionContext(stubDb().db, { ...input, settings: { ...SETTINGS, defaultLocale: 'en-US' } });
  assert.equal(en.ok && en.context.tenantGuard.primaryScript, 'Latin');
});

test('service names and the booking link are excluded from the script share', async () => {
  const r = await loadReceptionContext(stubDb().db, input);
  assert.deepEqual(r.ok && r.context.tenantGuard.scriptShareExclusions, ['CICA', 'https://www.matrixecosalon.org/']);
});

test('allowed_numbers comes from the SNAPSHOT, not from a live read of prices', async () => {
  // The snapshot is what the model was actually shown. Reading prices separately would
  // let the guard and the prompt disagree the moment a price is edited mid-conversation.
  const r = await loadReceptionContext(stubDb().db, input);
  assert.deepEqual(r.ok && r.context.tenantGuard.allowedNumbers, ['33,000']);
  assert.equal(r.ok && r.context.tenantGuard.promptCorpus, 'PREFIX');
});

test('hours and closures are loaded for L4, typed rather than passed through raw', async () => {
  const r = await loadReceptionContext(stubDb().db, input);
  assert.deepEqual(r.ok && r.context.hours, [{ weekday: 1, opens: '10:00:00', closes: '20:00:00', closed: false }]);
  assert.deepEqual(r.ok && r.context.closures, [
    { startsOn: '2026-09-07', endsOn: '2026-09-09', title: 'Наадам', message: 'Амарна.' },
  ]);
});

test('a null opens/closes survives as null, so "we do not know" is not "closed"', async () => {
  const r = await loadReceptionContext(stubDb({
    business_hours: { data: [{ weekday: 3, opens: null, closes: null, closed: false }] },
  }).db, input);
  assert.equal(r.ok && r.context.hours[0]?.opens, null);
});

test('EVERY failed read refuses; none is treated as an empty result', async () => {
  for (const table of ['disclosure_rules', 'out_of_scope_topics', 'canned_responses', 'tenant_booking', 'services', 'forbidden_phrasings', 'business_hours', 'tenant_closures', 'deterministic_replies']) {
    const r = await loadReceptionContext(stubDb({ [table]: { data: null, error: { message: 'down' } } }).db, input);
    assert.equal(r.ok, false, table);
    assert.equal(!r.ok && r.code, 'unavailable', table);
    assert.equal(!r.ok && r.detail.includes(table), true, table);
  }
});

test('a tenant with no canned responses is NOT PROVISIONED, not merely unavailable', async () => {
  // The distinction decides what the caller does: 503-and-retry versus alert an operator.
  const r = await loadReceptionContext(stubDb({ canned_responses: { data: [] } }).db, input);
  assert.equal(!r.ok && r.code, 'not_provisioned');
});

test('no published configuration is a provisioning state, never a default', async () => {
  const r = await loadReceptionContext(stubDb({ config_snapshots: { data: null, error: null } }).db, input);
  assert.equal(!r.ok && r.code, 'not_provisioned');
});

test('an unrecognised cache mode falls to off — the safe direction', async () => {
  // "off" pays full rate; a wrong TTL writes cache entries that are never read.
  const r = await loadReceptionContext(stubDb().db, {
    ...input, settings: { ...SETTINGS, promptCacheMode: 'forever' as unknown as '1h' },
  });
  assert.equal(r.ok && r.context.cacheMode, 'off');
});

test('concession stems come from the tenant\'s own Ш6 rule, so a garage differs from a salon', async () => {
  const r = await loadReceptionContext(stubDb({
    out_of_scope_topics: { data: [{
      topic_key: 'promos', matcher: { mode: 'contains_stem', stems: ['хямдр', 'урамшуул'] },
      response_kind: 'refusal_no_promotion', deterministic_shortcircuit: false,
    }] },
  }).db, input);
  assert.deepEqual(r.ok && r.context.tenantGuard.concessionStems, ['хямдр', 'урамшуул']);
});
