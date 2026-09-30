import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseMatcher, matcherTerms } from '../gate/match.ts';
import { ruleAppliesTo } from './classify.ts';

type Row = { rule_key: string; verdict: string; matcher: unknown; surfaces?: string[] };
const load = (v: string): Row[] =>
  (JSON.parse(readFileSync(new URL(`../../../scripts/provision/templates/comment_rules.${v}.json`, import.meta.url), 'utf8')) as { rules: Row[] }).rules;

const stems = (rows: Row[], surface: 'direct_message' | 'public_comment'): Set<string> => {
  const out = new Set<string>();
  for (const r of rows) {
    if (r.verdict !== 'escalate' || !ruleAppliesTo(r.surfaces ?? null, surface)) continue;
    const p = parseMatcher(r.matcher);
    assert.ok(p.ok, r.rule_key);
    if (p.ok) for (const s of matcherTerms(p.spec)) out.add(s);
  }
  return out;
};

const MOVED = ['муудсан', 'muudsan', 'хүлээлгэ', 'huleelge', 'hvleelge', 'дундуур', 'dunduur'];

for (const v of ['salon', 'software']) {
  test(`0073 (${v}): the wall still escalates every stem it did; the DM no longer reads the moved ones`, () => {
    const rows = load(v);
    const wall = stems(rows, 'public_comment');
    const dm = stems(rows, 'direct_message');
    for (const s of MOVED) {
      assert.ok(wall.has(s), `wall keeps ${s}`);
      assert.ok(!dm.has(s), `DM drops ${s}`);
    }
    // Every DM-only row is invisible to the wall.
    for (const r of rows.filter((x) => x.surfaces?.includes('direct_message') && !x.surfaces.includes('public_comment'))) {
      assert.ok(!ruleAppliesTo(r.surfaces, 'public_comment'), r.rule_key);
    }
    assert.equal(rows.filter((r) => r.rule_key.startsWith('person_')).length, 9);
  });
}
