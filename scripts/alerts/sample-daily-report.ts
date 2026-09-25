/**
 * Print the merged 09:00 report (DAILY_REPORT_V2, D-128) as it would be sent, from fixtures.
 *
 *     node scripts/alerts/sample-daily-report.ts
 *
 * No network, no database, no environment: every input below is a fixture, and the text is
 * produced by the SAME pure functions `runDigestJob` sends through — `planDigest`,
 * `renderDailyReport` (which lays out sections and cuts at Telegram's limit), the real
 * expiry-alert wording and the real flaw-report renderer. So what this prints is what the
 * founder would read, not a mock-up of it.
 *
 * Not a test and not run by CI (`npm test` globs `*.test.ts`); `npm run typecheck` covers it.
 */
import { planDigest, renderDailyReport, type YesterdaySummary } from '../../src/lib/alerts/digest.ts';
import type { OpenAlert } from '../../src/lib/alerts/alert.ts';
import { expiryAlertBody } from '../../src/lib/health/secretExpiry.ts';
import { renderFlawReport, type TenantReport } from '../../src/lib/quality/flaws.ts';

// 09:00 Ulaanbaatar on 2026-09-26: the report covers 2026-09-25.
const NOW = new Date('2026-09-26T01:00:00Z');
const hoursAgo = (h: number): Date => new Date(NOW.getTime() - h * 3_600_000);

const TENANT = '00000000-0000-4000-8000-000000000001';
const PAGE = '100000000000001';

// Section A, byte for byte what dalatech-app's own sample prints
// (`node scripts/sample-daily-section.mjs` in that repo, the same fixtures its tests use).
const APP_SECTION = [
  'DalaTech — лидүүд',
  '📊 Нийт: 7 · Шинэ хүсэлт (өнөөдөр): 1 · Демо бэлдэж байна: 1 · Демо илгээгдсэн: 3 · Загвар сонгосон: 1',
  '⚡ ЯАРАЛТАЙ:',
  '- #029 Хан Моторс — демо зогссон (generate:2) → RELEASE #029',
  '- #030 Алтай Тур ХХК — хүлээлгэсэн → RELEASE #030',
  '📞 Дагаж мэдэгдэх (өнөөдөр):',
  '- #021 Эрдэнэ Барилга — Эрдэнэбат, 8808-3030 · 7 өдөр · https://erdene-barilga-q4w9n-minimal.vercel.app',
  '- #026 Мөнх Шүдний Эмнэлэг — Мөнхзул, 9909-1515 · 3 өдөр · https://munkh-dental-x8d2m-minimal.vercel.app',
].join('\n');

// Section B's input: the open episodes.
const open: OpenAlert[] = [
  {
    id: 101, tenantId: TENANT, severity: 'critical', kind: 'channel.no_messages',
    dedupKey: `channel_silence:ch-1:no_messages`,
    body: `Page ${PAGE}: webhooks are arriving but nothing became a message for at least 5h of open `
      + `time with nothing, since ${hoursAgo(9).toISOString()} — a secondary-receiver (standby) Page, or the persist path`,
    at: hoursAgo(9), notifiedAt: null,
  },
  {
    id: 102, tenantId: TENANT, severity: 'warn', kind: 'secret.expiring',
    dedupKey: `secret_expiring:${TENANT}:page_token:data_access_expires_at:warn`,
    body: expiryAlertBody({
      tenantId: TENANT, kind: 'page_token', clock: 'data_access_expires_at', daysLeft: 24, severity: 'warn', route: 'digest',
    }),
    at: hoursAgo(30), notifiedAt: null,
  },
];

const plan = planDigest(open, {
  now: NOW,
  watchdogLastRan: new Date(NOW.getTime() - 35 * 60_000),
  channelsChecked: 2,
  dropped: { total: 1, byKind: { sticker: 1 }, unavailable: false },
  capped: { total: 0, posts: 0, unavailable: false },
  lostDrafts: { total: 0, latest: null, unavailable: false },
});

// Section C's input: what `quietRoute()` held back yesterday.
const cacheCold = (sample: number): string =>
  `The last ${sample} reception calls all read ZERO cached tokens. Prompt caching appears to have stopped. `
  + 'This is not an error and nothing will fail — it is a bill, roughly 2.5x at the design\'s prompt size. '
  + 'Most likely cause: something now varies per request inside the cached prefix.';
const yesterday: YesterdaySummary = {
  ok: true,
  truncated: false,
  rows: [
    { kind: 'model.cache_cold_run', severity: 'warn', body: cacheCold(10), at: hoursAgo(12) },
    { kind: 'model.cache_cold_run', severity: 'warn', body: cacheCold(10), at: hoursAgo(20) },
    { kind: 'channel.recovered', severity: 'info', body: `Page ${PAGE}: recovered — channel.no_webhooks is clear.`, at: hoursAgo(16) },
  ],
};

// Section D: one tenant, two replies that look wrong.
const report: TenantReport = {
  ok: true, name: 'Жишээ салон', slug: 'example', date: '2026-09-25', replies: 14,
  flaws: [
    {
      reasons: ['corrected'],
      pair: {
        ref: '3f9a1c2e', conversationId: 'conv-1', at: hoursAgo(22), replyAt: hoursAgo(22),
        customer: 'Маргааш 11 цагт үс засуулж болох уу?',
        reply: 'Маргааш бид амарна. Нөгөөдөр 10:00-аас ажиллана.',
      },
    },
    {
      reasons: ['handoff', 'repeated'],
      pair: {
        ref: 'b71d04aa', conversationId: 'conv-2', at: hoursAgo(18), replyAt: hoursAgo(18),
        customer: 'Кератин эмчилгээ хэд вэ?',
        reply: 'Уучлаарай, энэ талаар манай ажилтан тантай удахгүй холбогдоно.',
      },
    },
  ],
  learned: [],
  asks: [],
};

const messages = renderDailyReport({ app: APP_SECTION, plan, yesterday, flawText: renderFlawReport([report]), now: NOW });
messages.forEach((m, i) => {
  process.stdout.write(`=== message ${i + 1} of ${messages.length} · ${m.text.length} chars · sections: ${m.sections.join(', ')} ===\n`);
  process.stdout.write(`${m.text}\n`);
});
