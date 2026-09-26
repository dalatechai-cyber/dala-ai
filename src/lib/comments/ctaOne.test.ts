/**
 * DalaTech's «comment 1» call to action (D-144), against the REAL rows: the rule in
 * `templates/comment_rule.cta_one.json` beside tenant #0's software rule set, exactly as the
 * worker classifies a comment. No model is called anywhere on this path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyComment, type CommentRule } from './classify.ts';
import { MODEL_INVISIBLE_KINDS } from '../gate/match.ts';

type Row = { rule_key: string; verdict: CommentRule['verdict']; matcher: unknown; public_kind?: string; private_kind?: string };
const read = (p: string) => readFileSync(new URL(`../../../scripts/provision/${p}`, import.meta.url), 'utf8');
const CTA = JSON.parse(read('templates/comment_rule.cta_one.json')) as { rule: Row; lines: Record<string, string> };
const SOFTWARE = (JSON.parse(read('templates/comment_rules.software.json')) as { rules: Row[] }).rules;
const toRule = (r: Row): CommentRule => ({
  ruleKey: r.rule_key, verdict: r.verdict, matcher: r.matcher,
  lines: r.public_kind && r.private_kind ? { publicKind: r.public_kind, privateKind: r.private_kind } : null,
});
const RULES = [...SOFTWARE.map(toRule), toRule(CTA.rule)];

function classify(text: string) {
  const c = classifyComment({ text, attachments: [] }, RULES);
  if (!c.ok) throw new Error(c.detail);
  return c;
}

const CTA_LINES = { publicKind: 'comment_cta_public_reply', privateKind: 'comment_cta_private_reply' };

test('DONE-TEST: «1» AS PEOPLE REALLY TYPE IT ANSWERS THE CALL TO ACTION', () => {
  for (const t of ['1', ' 1 ', '1!', '1.', '1️⃣', '1⃣', '１', '1 👍', '👍 1', '1!!!', '1 🙏😊']) {
    const c = classify(t);
    assert.equal(c.verdict, 'reply', JSON.stringify(t));
    assert.deepEqual(c.lines, CTA_LINES, JSON.stringify(t));
  }
});

test('a comment with a real question in it keeps today\'s handling: the general lines', () => {
  for (const t of ['1 үнэ хэд вэ?', '1, демо яаж үзэх вэ?', 'Үнэ хэд вэ?', '1 гэж бичлээ. Хаана байрладаг вэ?']) {
    const c = classify(t);
    assert.equal(c.verdict, 'reply', t);
    assert.equal(c.lines, null, `${t}: not the call-to-action lines`);
  }
});

test('other numbers, and «1» inside words, are not the call to action', () => {
  for (const t of ['11', '12', '2', '10 000', '1 сая', 'Нэг', 'хүүхэд 1 настай']) {
    assert.notDeepEqual(classify(t).lines, CTA_LINES, t);
  }
});

test('a complaint written beside «1» is still escalated, never answered', () => {
  assert.equal(classify('1 луйвар').verdict, 'escalate');
});

test('the provisioning SQL inserts exactly this rule and exactly the approved sentences', () => {
  const sql = read('dalatech-comment-one-2026-09-26.sql');
  const m = sql.match(/\$m\$(.*?)\$m\$/su);
  assert.deepEqual(JSON.parse(m?.[1] ?? 'null'), CTA.rule.matcher);
  assert.ok(sql.includes(`'${CTA.rule.rule_key}'`));
  assert.equal(CTA.lines['comment_cta_public_reply'], 'Сайн байна уу! Дэлгэрэнгүй мэдээллийг чатаар илгээлээ 😊');
  assert.equal(CTA.lines['comment_cta_private_reply'],
    'Сайн байна уу! Би DalaTech-ийн AI туслах Дали байна. Энэ чатаар надаас хүссэн зүйлээ асуугаарай — үнэ, үйлчилгээ, үнэгүй демо, бүгдийг тайлбарлая.');
  for (const [kind, body] of Object.entries(CTA.lines)) {
    assert.ok(sql.includes(`('${kind}', $l$${body}$l$)`), kind);
  }
  assert.ok(sql.includes(`t.slug = 'dalatech'`) && !/matrix|tara/iu.test(sql.replace(/^--.*$/gmu, '')), 'tenant #0 only');
});

test('the two lines never enter the DM prompt (a row there would refuse every DalaTech DM)', () => {
  for (const kind of Object.keys(CTA.lines)) assert.ok(MODEL_INVISIBLE_KINDS.includes(kind), kind);
});
