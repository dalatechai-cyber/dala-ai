import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fallbackLineOf, loadReceptionContext, type TenantSettings } from './load.ts';

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

// --- the URL allow-list draws on BOTH tables that can hold a link (D-071) --------------

test('DONE-TEST: A MAPS URL IN contact_points IS ALLOWED, NOT REFUSED', async () => {
  // It was `tenant_booking.booking_url` alone. `contact_points.kind` has allowed `maps_url`
  // since `0001` and the compiler renders it into the prefix — so Matrix's location could
  // be given to the model, quoted correctly, and then thrown away by `urlsNotAllowed`.
  // That is D-068's shape in a different check: a reply punished for using approved data.
  const r = await loadReceptionContext(stubDb({
    contact_points: { data: [
      { kind: 'phone', value: '7741-7777' },
      { kind: 'maps_url', value: 'https://maps.app.goo.gl/fHaBVwc9mFZJxYAJ9' },
    ] },
  }).db, input);
  assert.equal(r.ok, true);
  const urls = r.ok ? r.context.tenantGuard.allowedUrls : [];
  assert.deepEqual(urls, ['https://www.matrixecosalon.org/', 'https://maps.app.goo.gl/fHaBVwc9mFZJxYAJ9']);
});

test('a phone or an address is not a link and never reaches the allow-list', async () => {
  const r = await loadReceptionContext(stubDb({
    contact_points: { data: [
      { kind: 'phone', value: '7741-7777' },
      { kind: 'address', value: 'Яармаг, 12-р хороо' },
      { kind: 'email', value: 'hi@matrixecosalon.org' },
    ] },
  }).db, input);
  assert.deepEqual(r.ok ? r.context.tenantGuard.allowedUrls : [], ['https://www.matrixecosalon.org/']);
});

test('all four URL kinds, not only the one needed today', async () => {
  // Restricting this to `maps_url` would rebuild the same gap for `website` the first time
  // anybody adds one — the "one branch over" failure D-062 names.
  const r = await loadReceptionContext(stubDb({
    tenant_booking: { data: [] },
    contact_points: { data: [
      { kind: 'website', value: 'https://matrixecosalon.org' },
      { kind: 'facebook', value: 'https://facebook.com/matrixecosalon' },
      { kind: 'instagram', value: 'https://instagram.com/matrixecosalon' },
      { kind: 'maps_url', value: 'https://maps.app.goo.gl/x' },
    ] },
  }).db, input);
  assert.equal((r.ok ? r.context.tenantGuard.allowedUrls : []).length, 4);
});

test('a handle stored where a link belongs is dropped rather than allowed', async () => {
  // `canonicalizeUrl` would turn `@matrix` into something no extracted URL matches, so it
  // is inert rather than dangerous — but an allow-list should contain links.
  const r = await loadReceptionContext(stubDb({
    tenant_booking: { data: [] },
    contact_points: { data: [{ kind: 'instagram', value: '' }, { kind: 'facebook', value: 'not a url at all' }] },
  }).db, input);
  assert.deepEqual(r.ok ? r.context.tenantGuard.allowedUrls : ['unset'], []);
});

test('DONE-TEST: an unreadable contact_points REFUSES rather than silently narrowing the allow-list', async () => {
  // Treating a failed read as "no contact points" would drop the tenant's own links out of
  // the allow-list and refuse every reply that used one — a guard tightening itself because
  // a query blipped. Undetermined is a result.
  const r = await loadReceptionContext(stubDb({
    contact_points: { error: { message: 'connection reset' } },
  }).db, input);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.code, 'unavailable');
});

test('the maps url is excluded from the Cyrillic script share, like every allowed link', async () => {
  // Latin characters in an approved URL must not count against `primaryScript`, or quoting
  // the location would trip `outbound_language` instead of `outbound_url`.
  const r = await loadReceptionContext(stubDb({
    contact_points: { data: [{ kind: 'maps_url', value: 'https://maps.app.goo.gl/fHaBVwc9mFZJxYAJ9' }] },
  }).db, input);
  assert.ok((r.ok ? r.context.tenantGuard.scriptShareExclusions : []).includes('https://maps.app.goo.gl/fHaBVwc9mFZJxYAJ9'));
});

test('THE GUARD IS HANDED THE GATE, NOT THE WHOLE PREFIX', () => {
  // D-084, founder's call 2026-09-18. A customer reading the tenant's own knowledge base
  // has been answered, not shown the prompt. Before this the corpus was `prompt_stable`,
  // so a reply quoting the KB was a disclosure — measured at 04:02 that day, when a correct
  // answer about the number of branches was discarded for the generic handoff.
  return (async () => {
    const withGate = stubDb({
      config_snapshots: { data: { ...SNAPSHOT, prompt_gate: 'GATE BLOCKS ONLY' }, error: null },
    });
    const r = await loadReceptionContext(withGate.db, input);
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.context.tenantGuard.promptCorpus, 'GATE BLOCKS ONLY');
  })();
});

test('a snapshot published before 0029 falls back to the whole prefix', () => {
  // Null is a FORMAT marker, not "unknown". The fallback is today's behaviour, which
  // over-refuses rather than under-refuses, and the next republish narrows it. Reading
  // null as "no corpus" would silently disable the disclosure check — the one direction
  // that must never be the default.
  return (async () => {
    const r = await loadReceptionContext(stubDb().db, input);
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.context.tenantGuard.promptCorpus, 'PREFIX');
  })();
});

test('approved percentages come from the snapshot’s tenant sections, never from the gate’s counter-examples', async () => {
  // The gate quotes «10% хямдралтай» as the answer it forbids; the tenant's own FAQ states
  // its team discount. Only the tenant's figures may pass the percentage check.
  const gate = 'Буруу хариулт: «эхний удаа 10% хямдралтай.»';
  const stable = `${gate}\n\nХоёр ажилтан −10%, гурав −15%. Гэрээ байгуулахад 50%.`;
  const r = await loadReceptionContext(stubDb({
    config_snapshots: { data: { ...SNAPSHOT, prompt_stable: stable, prompt_gate: gate }, error: null },
  }).db, input);
  assert.deepEqual(r.ok ? r.context.tenantGuard.approvedPercentages : null, ['10', '15', '50']);
  const gateOnly = await loadReceptionContext(stubDb({
    config_snapshots: { data: { ...SNAPSHOT, prompt_stable: `${gate}\n\nҮс засалт 33,000₮`, prompt_gate: gate }, error: null },
  }).db, input);
  assert.deepEqual(gateOnly.ok ? gateOnly.context.tenantGuard.approvedPercentages : null, []);
});

test('a demo link in the contact details is an allowed link, like the homepage', async () => {
  const r = await loadReceptionContext(stubDb({
    contact_points: {
      data: [{ kind: 'website', value: 'https://dalatech.online/' }, { kind: 'demo_url', value: 'https://app.dalatech.online' }],
      error: null,
    },
  }).db, input);
  const urls = r.ok ? r.context.tenantGuard.allowedUrls : [];
  assert.ok(urls.includes('https://app.dalatech.online'), urls.join(' '));
  assert.ok(urls.includes('https://dalatech.online/'), urls.join(' '));
});

test('the fallback line is the REVIEWED, ENABLED callback row, and anything else is null', () => {
  const body = 'Нэр, утасны дугаараа энд бичиж үлдээвэл хамт олон маань тантай холбогдоно.';
  const reviewed = { body, enabled: true, reviewed_at: '2026-09-26T00:00:00Z' };
  assert.equal(fallbackLineOf({ data: [reviewed], error: null }), body);
  assert.equal(fallbackLineOf({ data: [{ ...reviewed, enabled: false }], error: null }), null, 'Tara: approved but unused');
  assert.equal(fallbackLineOf({ data: [{ ...reviewed, reviewed_at: null }], error: null }), null, 'unreviewed wording is never served');
  assert.equal(fallbackLineOf({ data: [{ ...reviewed, body: null }], error: null }), null);
  assert.equal(fallbackLineOf({ data: [], error: null }), null);
  assert.equal(fallbackLineOf({ data: null, error: { message: 'relation does not exist' } }), null, 'a failed read is the old line');
});

test('a contact value is excluded from the script share, so an e-mail answer is Mongolian', async () => {
  const r = await loadReceptionContext(stubDb({
    contact_points: { data: [{ kind: 'email', value: 'dalatech.ai@gmail.com' }], error: null },
  }).db, input);
  assert.ok(r.ok && r.context.tenantGuard.scriptShareExclusions.includes('dalatech.ai@gmail.com'));
});

test('a sales_next_steps read that fails does not refuse the reply', async () => {
  const r = await loadReceptionContext(stubDb({ sales_next_steps: { data: null, error: { message: 'boom' } } }).db, input);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.context.fallbackLine, null);
});

test('a client that THROWS building the sales_next_steps query does not refuse the reply either', async () => {
  const { db } = stubDb();
  const throwing = { from: (t: string) => { if (t === 'sales_next_steps') throw new Error('no such table in this dump'); return (db as { from: (t: string) => unknown }).from(t); } };
  const r = await loadReceptionContext(throwing as never, input);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.context.fallbackLine, null);
});
