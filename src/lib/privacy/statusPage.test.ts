import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  escapeHtml,
  loadStatusBlocks,
  renderStatusPage,
  stateBlockFor,
  STATUS_BLOCK_KEYS,
  type StatusBlocks,
} from './statusPage.ts';

const MN: StatusBlocks = {
  data_deletion_title: 'Мэдээлэл устгах хүсэлт',
  data_deletion_intro: 'Таны хүсэлтийн төлөв энд харагдана.',
  data_deletion_code_label: 'Баталгааны код',
  data_deletion_requested_label: 'Хүсэлт өгсөн огноо',
  data_deletion_state_received: 'Хүсэлтийг хүлээн авсан.',
  data_deletion_state_completed: 'Мэдээллийг устгасан.',
  data_deletion_state_failed: 'Хүсэлтийг гүйцэтгэж чадаагүй.',
  data_deletion_not_found: 'Ийм кодтой хүсэлт олдсонгүй.',
};

type Reply = { data?: unknown; error?: unknown };

function stubDb(reply: Reply) {
  const filters: Record<string, unknown> = {};
  const chain: Record<string, unknown> = {};
  for (const m of ['select'] as const) chain[m] = () => chain;
  chain['eq'] = (c: string, v: unknown) => ((filters[c] = v), chain);
  chain['is'] = (c: string, v: unknown) => ((filters[`is:${c}`] = v), chain);
  chain['not'] = (c: string, op: string, v: unknown) => ((filters[`not:${c}`] = `${op} ${String(v)}`), chain);
  chain['in'] = (c: string, v: unknown) => ((filters[`in:${c}`] = v), chain);
  chain['then'] = (res: (v: unknown) => unknown) => res(reply);
  return { filters, db: { from: () => chain } as never };
}

const rows = (keys: readonly string[]) => keys.map((block_key) => ({ block_key, body: MN[block_key as never] }));

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test('all eight signed blocks load', async () => {
  const { db } = stubDb({ data: rows(STATUS_BLOCK_KEYS), error: null });
  const out = await loadStatusBlocks(db);
  assert.equal(out.ok, true);
  assert.deepEqual(out.ok && out.blocks, MN);
});

test('DONE-TEST: the query asks only for platform blocks that are SIGNED', async () => {
  // `reviewed_at is not null` in the WHERE clause, not checked afterwards: an unsigned
  // block must be unreadable here, not merely unused.
  const { db, filters } = stubDb({ data: rows(STATUS_BLOCK_KEYS), error: null });
  await loadStatusBlocks(db);
  assert.equal(filters['scope'], 'platform');
  assert.equal(filters['is:tenant_id'], null);
  assert.equal(filters['not:reviewed_at'], 'is null');
  assert.deepEqual(filters['in:block_key'], [...STATUS_BLOCK_KEYS]);
});

test('DONE-TEST: one missing block refuses the whole page — there is no fallback string', async () => {
  // A page that renders seven signed sentences and one English one ships unreviewed
  // platform Mongolian without ever failing a build.
  for (const missing of STATUS_BLOCK_KEYS) {
    const { db } = stubDb({ data: rows(STATUS_BLOCK_KEYS.filter((k) => k !== missing)), error: null });
    const out = await loadStatusBlocks(db);
    assert.equal(out.ok, false, missing);
    assert.equal(out.ok === false && out.reason, 'unsigned', missing);
    assert.deepEqual(out.ok === false && out.reason === 'unsigned' ? out.missing : [], [missing]);
  }
});

test('an empty body counts as missing, not as a signed empty sentence', async () => {
  const { db } = stubDb({
    data: [...rows(STATUS_BLOCK_KEYS.slice(1)), { block_key: STATUS_BLOCK_KEYS[0], body: '   ' }],
    error: null,
  });
  const out = await loadStatusBlocks(db);
  assert.equal(out.ok, false);
  assert.deepEqual(out.ok === false && out.reason === 'unsigned' ? out.missing : [], [STATUS_BLOCK_KEYS[0]]);
});

test('an unreadable table is unavailable, and distinguishable from unsigned', async () => {
  const { db } = stubDb({ error: { message: 'reset' } });
  const out = await loadStatusBlocks(db);
  assert.equal(out.ok === false && out.reason, 'unavailable');
});

// ---------------------------------------------------------------------------
// Which sentence a state gets
// ---------------------------------------------------------------------------

test('no_match reads to the person as failed, not as done', async () => {
  // "We could not match your id to any record" is our problem to fix, not a resolution.
  // Showing it as completed would be the confirmation code lying in a second place.
  assert.equal(stateBlockFor('no_match'), 'data_deletion_state_failed');
  assert.equal(stateBlockFor('failed'), 'data_deletion_state_failed');
  assert.equal(stateBlockFor('completed'), 'data_deletion_state_completed');
  assert.equal(stateBlockFor('received'), 'data_deletion_state_received');
  assert.equal(stateBlockFor('matched'), 'data_deletion_state_received', 'in progress, from outside');
});

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

test('a found request renders its state, code and date, and nothing else about anybody', () => {
  const html = renderStatusPage(MN, {
    found: true,
    code: 'ABCDEFGHJKLMNPQRSTUVWXYZ'.slice(0, 24),
    status: 'received',
    requestedAt: new Date('2026-09-04T12:34:56Z'),
  });
  assert.match(html, /lang="mn"/);
  assert.ok(html.includes(MN.data_deletion_state_received));
  assert.ok(html.includes('2026-09-04'), 'the date, without a time we would be inventing precision for');
  assert.ok(!html.includes('12:34'));
  assert.ok(html.includes('ABCDEFGHJKLMNPQRSTUVWXYZ'.slice(0, 24)));
  assert.match(html, /noindex/, 'a status page must not be indexed');
  assert.ok(!/<script/i.test(html), 'nothing executable on a page with nothing to do');
});

test('a missing request renders the not-found sentence and no code or date', () => {
  const html = renderStatusPage(MN, { found: false });
  assert.ok(html.includes(MN.data_deletion_not_found));
  assert.ok(!html.includes(MN.data_deletion_code_label));
  assert.ok(!html.includes(MN.data_deletion_requested_label));
});

test('Mongolian Cyrillic survives rendering unchanged', () => {
  // Every block appears on one of the two pages, byte for byte. Rendering is the last
  // boundary before a customer reads it, and an NFC/NFD slip or a stray escape here would
  // be invisible in review.
  const pages = [
    renderStatusPage(MN, { found: false }),
    renderStatusPage(MN, { found: true, code: 'A'.repeat(24), status: 'received', requestedAt: new Date() }),
    renderStatusPage(MN, { found: true, code: 'A'.repeat(24), status: 'completed', requestedAt: new Date() }),
    renderStatusPage(MN, { found: true, code: 'A'.repeat(24), status: 'failed', requestedAt: new Date() }),
  ];
  for (const block of Object.values(MN)) {
    assert.ok(pages.some((p) => p.includes(block)), block);
  }
  assert.ok(pages.join('').includes('ү'), 'Mongolian letters, not transliterated');
});

test('every interpolated value is escaped, whatever its provenance', () => {
  // The blocks are founder-signed, so this is not the boundary that stops an injection.
  // It runs anyway, because "this value is trusted" stops being true when a field is added.
  const hostile: StatusBlocks = { ...MN, data_deletion_intro: '<script>alert(1)</script> & "quotes"' };
  const html = renderStatusPage(hostile, { found: false });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&amp;'));
});

test('escapeHtml leaves Cyrillic alone and touches only the five characters', () => {
  assert.equal(escapeHtml('Сайн байна уу! Ёлка ӨҮ'), 'Сайн байна уу! Ёлка ӨҮ');
  assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
});

test('a null requested date renders as a dash rather than an Invalid Date', () => {
  const html = renderStatusPage(MN, { found: true, code: 'A'.repeat(24), status: 'completed', requestedAt: null });
  assert.ok(html.includes('—'));
  assert.ok(!html.includes('Invalid'));
});

// ---------------------------------------------------------------------------
// The REAL signed text, through the real renderer
// ---------------------------------------------------------------------------

test('DONE-TEST: the signed platform blocks render a page, not an approximation of one', () => {
  // Every test above uses a fixture. This one reads the eight files a native speaker
  // actually signed and puts them through the renderer, which is the last boundary before
  // a customer reads them. It catches what a fixture cannot: a block that is empty, that
  // is not NFC, or that contains a character the escaper has to touch — none of which are
  // visible to somebody reviewing Mongolian prose.
  const signed = Object.fromEntries(
    STATUS_BLOCK_KEYS.map((k) => [k, readFileSync(`prompt/platform/${k}.mn.txt`, 'utf8').trim()]),
  ) as StatusBlocks;

  for (const [key, body] of Object.entries(signed)) {
    assert.notEqual(body, '', key);
    assert.equal(body.normalize('NFC'), body, `${key} is not NFC`);
  }

  const html = renderStatusPage(signed, {
    found: true,
    code: 'ABCDEFGHJKLMNPQRSTUVWX23',
    status: 'received',
    requestedAt: new Date('2026-09-04T00:00:00Z'),
  });
  assert.ok(html.includes(signed.data_deletion_title));
  assert.ok(html.includes(signed.data_deletion_state_received));
  assert.ok(html.includes('2026-09-04'));
  // The signed text must survive the escaper unchanged — if a block ever gains an
  // ampersand or a quote, this says so rather than silently shipping an entity.
  assert.ok(html.includes(signed.data_deletion_intro), 'the intro is altered by escaping');
  assert.ok(!/<script/i.test(html));
});
