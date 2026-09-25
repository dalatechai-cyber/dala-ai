/**
 * The retrospective shadow (D-127) as a permanent test: the numbers in
 * docs/reports/2026-09-26-sales-shadow.md are what the code says about last week's real
 * conversations, and they cannot drift from it silently.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadCorpus, runRetro } from './retro.ts';
import { parsePlaybook } from '../../src/lib/sales/nextStep.ts';
import { detectPhones } from '../../src/lib/sales/phone.ts';

test('the control: the transcribed corpus reproduces the live table hash', () => {
  const rows = loadCorpus();
  assert.equal(rows.length, 146);
  const md5 = createHash('md5').update(rows.map((r) => r[3]).join('|')).digest('hex');
  assert.equal(md5, '51ae6b3a9b0a0ba5edbd80378e63d5c2');
});

test('both templates parse with the runtime parser', () => {
  for (const t of ['salon', 'software']) {
    const doc = JSON.parse(readFileSync(new URL(`../provision/templates/sales_playbook.${t}.json`, import.meta.url), 'utf8')) as {
      lead_route: string; steps: Record<string, unknown>[]; pairings: Record<string, unknown>[];
    };
    const p = parsePlaybook({ mode: 'shadow', lead_route: doc.lead_route, steps: doc.steps, pairings: doc.pairings });
    assert.ok(p.ok, t);
  }
});

test('the report numbers', () => {
  const turns = runRetro();
  const summary = (tenant: 'T' | 'D') => {
    const mine = turns.filter((t) => t.tenant === tenant);
    const convs = new Set(mine.map((t) => t.conversation));
    const offered = new Set(mine.filter((t) => t.decision.nextStep.verdict === 'offer' || t.decision.nextStep.verdict === 'in_reply')
      .map((t) => t.conversation));
    return {
      messages: mine.length,
      conversations: convs.size,
      withNextStep: offered.size,
      offers: mine.filter((t) => t.decision.nextStep.verdict === 'offer').length,
      leads: mine.filter((t) => t.decision.lead.detected).length,
      related: mine.filter((t) => t.decision.related !== null).length,
    };
  };
  assert.deepEqual(summary('T'), { messages: 140, conversations: 37, withNextStep: 17, offers: 16, leads: 0, related: 1 });
  assert.deepEqual(summary('D'), { messages: 6, conversations: 2, withNextStep: 1, offers: 1, leads: 1, related: 0 });
});

test('no quoted message carries a phone number unmasked', () => {
  // The detector itself is the judge: nothing it would call a phone survives the mask.
  for (const t of runRetro()) assert.deepEqual(detectPhones(t.quoted, []), [], t.quoted);
  const quotedLead = runRetro().find((t) => t.decision.lead.detected);
  assert.ok(quotedLead?.quoted.includes('7600****'));
});
