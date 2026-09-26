/**
 * Founder, 2026-09-27, through the real reply path over each tenant's committed live rows:
 *
 *  - «bnu» got «Уучлаарай, ойлгосонгүй» from the model (Tara, 2026-09-26 18:05). Every common
 *    greeting and thanks — Latin letters or Cyrillic shorthand — is answered by the tenant's own
 *    greeting / thanks row, with NO model, exactly as the full Cyrillic is.
 *  - «үс будалт цаг авъя» was sent the deposit rows without «урьдчилгаа» (Tara, 2026-09-26
 *    12:39). The model's live text, stubbed here, now reaches the customer with every deposit
 *    labelled. No model is called: the stub stands in for it and spends nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withCases } from './overlay.ts';
import { fixtureDb, type Dump } from '../bakeoff/fixtureDb.ts';
import { gateTenant } from '../../src/lib/replycases/run.ts';
import { taraDump } from './fixtures.ts';

function dalatechDump(): Dump {
  const d = JSON.parse(readFileSync('scripts/bakeoff/dalatech-live.json', 'utf8')) as Dump;
  for (const r of d['deterministic_replies'] ?? []) if (!('matcher' in r)) r['matcher'] = null;
  return d;
}

const TARA_GREETING = 'Сайн байна уу! Tara Salon-д тавтай морил. Танд юугаар туслах вэ?';

type Case = { message: string; expected: string };

async function answers(dump: Dump, slug: string, cases: readonly Case[], callModel: Parameters<typeof gateTenant>[1]['callModel'] = null) {
  const tenantId = dump['tenants']?.[0]?.['id'];
  const rows = cases.map((c, i) => ({
    id: i + 1, tenant_id: tenantId, active: true, customer_message: c.message, history: [],
    expected_body: c.expected, must_include: [], must_not_include: [], note: null, channel: 'facebook_page',
  }));
  const g = await gateTenant(withCases(fixtureDb(dump), rows), { slug, now: new Date('2026-09-27T04:00:00Z'), callModel });
  assert.ok(g.ok, JSON.stringify(g));
  return g.ok ? g.results : [];
}

const GREETINGS = ['bnu', 'Bnu?', 'bnuu', 'sn bnu', 'sn bnuu', 'sain bnu uu', 'sain bnuu', 'bna uu', 'байна уу', 'бну', 'сн бну'];

test('DONE-TEST: TARA ANSWERS «bnu» AND EVERY COMMON GREETING SHAPE WITH ITS GREETING ROW — NO MODEL', async () => {
  const results = await answers(taraDump(), 'matrix-eco-salon', GREETINGS.map((message) => ({ message, expected: TARA_GREETING })));
  for (const r of results) {
    assert.equal(r.pass, true, JSON.stringify(r));
    assert.equal(r.answeredBy, 'deterministic', JSON.stringify(r));
  }
});

test('DONE-TEST: DALATECH ANSWERS THE SAME GREETINGS, AND LATIN THANKS, WITH ITS OWN ROWS — NO MODEL', async () => {
  const dump = dalatechDump();
  const body = (intent: string): string => String((dump['deterministic_replies'] ?? []).find((r) => r['intent'] === intent)?.['body']);
  const cases = [
    ...GREETINGS.map((message) => ({ message, expected: body('greeting') })),
    ...['bayrlalaa', 'bayarlalaa', 'ih bayrlalaa', 'Bayrllaa!', 'thx', 'баярллаа'].map((message) => ({ message, expected: body('thanks') })),
  ];
  const results = await answers(dump, 'dalatech', cases);
  for (const r of results) {
    assert.equal(r.pass, true, JSON.stringify(r));
    assert.equal(r.answeredBy, 'deterministic', JSON.stringify(r));
  }
});

test('a short question in Latin letters is answered exactly as the same question in Cyrillic', async () => {
  const dump = dalatechDump();
  const pairs: [string, string][] = [['une hed ve', 'үнэ хэд вэ'], ['uniin medeelel', 'үнийн мэдээлэл'], ['demo avya', 'демо авъя']];
  for (const [latin, cyrillic] of pairs) {
    const [a, b] = await answers(dump, 'dalatech', [{ message: cyrillic, expected: '' }, { message: latin, expected: '' }]);
    assert.equal(a?.answeredBy, b?.answeredBy, `${latin} / ${cyrillic}`);
    assert.equal(a?.reply, b?.reply, `${latin} / ${cyrillic}`);
  }
});

test('DONE-TEST: TARA\'S LIVE 12:39 COLOUR-BOOKING REPLY NOW REACHES THE CUSTOMER WITH EVERY DEPOSIT LABELLED', async () => {
  // Exactly what went out on 2026-09-26 12:39, as the model's text.
  const live = '1-р зэргийн үсчин: 10,000₮\nМастер үсчин: 20,000₮\n\n'
    + 'Та манай вэбсайтаар (https://www.matrixecosalon.org/) онлайнаар цаг захиалж, урьдчилгаа төлбөрөө QPay-ээр төлөх боломжтой.';
  const [r] = await answers(taraDump(), 'matrix-eco-salon', [{ message: 'үс будалт цаг авъя', expected: '' }], async () => ({
    kind: 'ok', text: live, modelReturned: 'stub', stopReason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }));
  const reply = r?.reply ?? '';
  assert.ok(reply !== '', JSON.stringify(r));
  const amountLines = reply.split('\n').filter((l) => /10,000₮|20,000₮/u.test(l));
  assert.equal(amountLines.length, 2, reply);
  for (const line of amountLines) assert.ok(line.startsWith('Урьдчилгаа төлбөр — '), line);
  assert.ok(reply.includes('https://www.matrixecosalon.org/'), 'the booking line stays');
});
