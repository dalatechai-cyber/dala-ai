/**
 * Quality round of 2026-10-03 (docs/reports/2026-10-03-tara-dali-quality.md), the data half:
 * `scripts/provision/tara-dali-quality-2026-10-03.sql` adds «авч»-family stems to Tara's fixed
 * `booking` reply. Proven here through the real reply path (`gateTenant`) over Tara's committed
 * dump, with the booking row as it is live today (`tara-fixed-replies-2026-09-30.sql`), before and
 * after the file. No model: a case that would reach it is answered by nobody here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withCases } from './overlay.ts';
import { fixtureDb, type Dump } from '../bakeoff/fixtureDb.ts';
import { gateTenant } from '../../src/lib/replycases/run.ts';
import { taraDump } from './fixtures.ts';

const BOOKING_BODY = 'Та манай вэбсайтаар (https://www.matrixecosalon.org/) онлайнаар цаг захиалж, урьдчилгаа төлбөрөө QPay-ээр төлөх боломжтой.';
// The live row, 2026-10-03 (read-only), as tara-fixed-replies-2026-09-30.sql wrote it.
const LIVE_STEMS = ['авах', 'авья', 'авъя', 'авий', 'авмаар', 'авдаг', 'захиалах', 'захиалъя', 'захиалья', 'захиалмаар', 'захиалдаг',
  'awah', 'avah', 'awhuu', 'avahuu', 'avhuu', 'awii', 'avii', 'awya', 'avya', 'awdag', 'avdag', 'awmaar', 'avmaar', 'zahialah',
  'zahialya', 'zahialmaar', 'zahialdag'];
const LIVE_COVER = ['цаг', 'цагаа', 'гэсэн', 'юм', 'би', 'танайх', 'танайд', 'онлайн', 'яаж', 'уу', 'үү', 'вэ', 'бэ', 'ве', 'юу', 'сайн',
  'байна', 'бна', 'бну', 'бнуу', 'tsag', 'tsagaa', 'gesen', 'gsn', 'yum', 'bi', 'tanaih', 'tanaid', 'online', 'onlain', 'yaaj', 'uu',
  'vv', 'we', 've', 'be', 'yu', 'sain', 'bna', 'bnu', 'bnuu', 'sn', 'hi', 'hello'];
// What tara-dali-quality-2026-10-03.sql adds. Keep in step with that file.
const NEW_STEMS = ['авч', 'awch', 'avch', 'абч', 'abch'];
const NEW_COVER = ['очих', 'ochih', 'очиж', 'ochij', 'болох', 'boloh', 'bolh'];

function dumpWithBooking(stems: readonly string[], cover: readonly string[]): Dump {
  const d = taraDump();
  const tenantId = d['tenants']?.[0]?.['id'];
  const rows = (d['deterministic_replies'] ?? []).filter((r) => r['intent'] !== 'booking');
  rows.push({
    tenant_id: tenantId, intent: 'booking', body: BOOKING_BODY, web_body: null, enabled: true, match_mode: 'covers_message',
    stems: [...stems], cover_words: [...cover], placement: 'replace', quote_services: [], requires_empty_history: false,
    provenance: 'tenant_confirmed', matcher: null,
  });
  d['deterministic_replies'] = rows;
  return d;
}

async function answer(dump: Dump, message: string) {
  const tenantId = dump['tenants']?.[0]?.['id'];
  const row = {
    id: 1, tenant_id: tenantId, active: true, customer_message: message, history: [], expected_body: null,
    must_include: ['https://www.matrixecosalon.org/'], must_not_include: [], note: null, channel: 'facebook_page',
  };
  const g = await gateTenant(withCases(fixtureDb(dump), [row]), { slug: 'matrix-eco-salon', now: new Date('2026-10-03T04:00:00Z'), callModel: null });
  assert.ok(g.ok, JSON.stringify(g));
  const r = g.ok ? g.results[0] : undefined;
  assert.ok(r !== undefined);
  return r;
}

test('DONE-TEST (Tara, 2026-10-01): «Tsag awch ochih uu» AND «цаг авч болох уу» ARE ANSWERED BY THE BOOKING ROW, WITH THE DEPOSITS, NO MODEL', async () => {
  const dump = dumpWithBooking([...LIVE_STEMS, ...NEW_STEMS], [...LIVE_COVER, ...NEW_COVER]);
  for (const message of ['Tsag awch ochih uu', 'цаг авч болох уу', 'Tsag avch boloh uu']) {
    const r = await answer(dump, message);
    assert.equal(r.answeredBy, 'deterministic', `${message}: ${JSON.stringify(r)}`);
    assert.ok((r.reply ?? '').includes(BOOKING_BODY), `${message}: ${r.reply ?? ''}`);
    assert.ok((r.reply ?? '').includes('Урьдчилгаа төлбөр — '), `${message}: the deposits are above the link`);
  }
});

test('before the file, the same message is not the booking row (it went to the model, live: the hand-off line)', async () => {
  const r = await answer(dumpWithBooking(LIVE_STEMS, LIVE_COVER), 'Tsag awch ochih uu');
  assert.notEqual(r.answeredBy, 'deterministic', JSON.stringify(r));
});

test('«авч» about something other than a time is not covered: the booking row stays silent', async () => {
  const dump = dumpWithBooking([...LIVE_STEMS, ...NEW_STEMS], [...LIVE_COVER, ...NEW_COVER]);
  for (const message of ['мэдээлэл авч болох уу', 'zurag awch boloh uu', 'үнэ авч болох уу']) {
    const r = await answer(dump, message);
    assert.notEqual(r.answeredBy === 'deterministic' && (r.reply ?? '').includes(BOOKING_BODY), true, `${message}: ${JSON.stringify(r)}`);
  }
});
