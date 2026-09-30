import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SkippedEvent } from '../meta/extract.ts';
import {
  channelLabel, complaintFires, needsPersonAlertBody, needsPersonDedupKey, planVoiceAlone, raiseNeedsPerson, voiceDedupKey,
} from './needsPerson.ts';

const skip = (over: Partial<SkippedEvent>): SkippedEvent => ({
  reason: 'no_text', idx: 0, externalId: 'm.1', senderId: 'psid-1', recipientId: null,
  attachments: [], stickerIds: [], ...over,
} as SkippedEvent);

test('a voice message alone is planned; a sticker, a photo, a captioned message and an echo are not', () => {
  assert.deepEqual(planVoiceAlone([skip({ attachments: ['audio'] })]), [{ idx: 0, senderId: 'psid-1', externalId: 'm.1' }]);
  assert.deepEqual(planVoiceAlone([skip({ attachments: ['audio'], stickerIds: ['1'] })]), []);
  assert.deepEqual(planVoiceAlone([skip({ attachments: ['image'] })]), []);
  assert.deepEqual(planVoiceAlone([skip({ reason: 'echo', attachments: ['audio'] })]), []);
  assert.deepEqual(planVoiceAlone([skip({ attachments: ['audio'], senderId: null })]), []);
});

test('three voice notes from one sender in one entry are one plan; two senders are two', () => {
  const three = [0, 1, 2].map((idx) => skip({ idx, attachments: ['audio'] }));
  assert.equal(planVoiceAlone(three).length, 1);
  assert.equal(planVoiceAlone([skip({ attachments: ['audio'] }), skip({ idx: 1, senderId: 'psid-2', attachments: ['audio'] })]).length, 2);
});

test('the complaint check reads only escalate rows, and a malformed rule pages nobody', () => {
  const rules = [{ ruleKey: 'c', verdict: 'escalate' as const, matcher: { mode: 'contains_stem', stems: ['гомдол'] } }];
  assert.equal(complaintFires('Гомдол байна', rules, null), true);
  assert.equal(complaintFires('Үнэ хэд вэ', rules, null), false);
  assert.equal(complaintFires('Гомдол байна', [], null), false);
  assert.equal(complaintFires('Гомдол байна', [{ ruleKey: 'bad', verdict: 'escalate', matcher: { mode: 'nope' } }], null), false);
  // A Latin spelling reaches the rule through the respelled text (D-120).
  assert.equal(complaintFires('gmdl', rules, 'гомдол'), true);
});

test('the alert carries ids and the reason, never the customer\'s words', () => {
  const body = needsPersonAlertBody({ tenantName: 'Tara Salon — Яармаг', reason: 'voice', channel: 'Messenger', conversationId: 'conv-9', answered: false });
  assert.match(body, /Tara Salon — Яармаг \(Messenger\)/);
  assert.match(body, /voice message/);
  assert.match(body, /sent NOTHING/);
  assert.match(body, /conv-9/);
  assert.match(needsPersonAlertBody({ tenantName: 'T', reason: 'complaint', channel: 'Instagram', conversationId: 'c', answered: true }), /The bot replied/);
});

test('one alert per conversation, reason and Ulaanbaatar day (D-151)', () => {
  // 23:30 UTC on the 29th is 07:30 on the 30th in Ulaanbaatar.
  assert.equal(needsPersonDedupKey('c', 'complaint', new Date('2026-09-29T23:30:00Z')), 'needs_person:c:complaint:2026-09-30');
  assert.equal(needsPersonDedupKey('c', 'complaint', new Date('2026-09-29T15:30:00Z')), 'needs_person:c:complaint:2026-09-29');
  assert.notEqual(needsPersonDedupKey('c', 'voice', new Date('2026-09-29T15:30:00Z')), needsPersonDedupKey('c', 'handoff', new Date('2026-09-29T15:30:00Z')));
  assert.equal(voiceDedupKey(12, 3), 'voice:12:3');
  assert.equal(channelLabel('instagram'), 'Instagram');
  assert.equal(channelLabel('facebook_page'), 'Messenger');
});

test('raiseNeedsPerson pages now, once, with the tenant\'s name, and ignores the media switch', async () => {
  const inserted: Record<string, unknown>[] = [];
  const reads: string[] = [];
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'is', 'limit', 'in', 'update']) chain[m] = () => chain;
    chain['select'] = (cols: string) => { reads.push(`${table}:${cols}`); return chain; };
    chain['insert'] = (row: Record<string, unknown>) => { inserted.push(row); return chain; };
    chain['maybeSingle'] = async () => (table === 'tenants'
      ? { data: { display_name: 'Tara Salon — Яармаг', media_handoff_alert: false }, error: null }
      : inserted.length > 0 ? { data: { id: 1 }, error: null } : { data: null, error: null });
    return chain;
  };
  const prev = process.env['ALERTS_ENABLED'];
  process.env['ALERTS_ENABLED'] = 'false';
  try {
    const out = await raiseNeedsPerson({ from } as never, {
      tenantId: 't', conversationId: 'conv-1', reason: 'voice', provider: 'facebook_page', answered: false, now: new Date('2026-09-30T02:00:00Z'),
    });
    assert.equal(out.outcome, 'recorded_undelivered');
  } finally {
    if (prev === undefined) delete process.env['ALERTS_ENABLED']; else process.env['ALERTS_ENABLED'] = prev;
  }
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0]?.['route'], 'now');
  assert.equal(inserted[0]?.['repeat_policy'], 'once');
  assert.equal(inserted[0]?.['dedup_key'], 'needs_person:conv-1:voice:2026-09-30');
  assert.match(String(inserted[0]?.['body']), /Tara Salon — Яармаг/);
  assert.ok(!reads.some((r) => r.includes('media_handoff_alert')), 'D-153\'s switch is not read here');
});
