/**
 * The software comment-rule template (tenant #0, DalaTech's own Page, founder 2026-09-26).
 * Reply only to comments that ask something; the words of the company's own ads —
 * «Message», «combo» — are always answered; praise, laughs, tags and greetings stay silent;
 * complaints are escalated, never answered.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyComment, type CommentRule } from './classify.ts';

const TEMPLATE = JSON.parse(readFileSync(new URL('../../../scripts/provision/templates/comment_rules.software.json', import.meta.url), 'utf8')) as {
  rules: { rule_key: string; verdict: CommentRule['verdict']; matcher: unknown }[];
};
const RULES: CommentRule[] = TEMPLATE.rules.map((r) => ({ ruleKey: r.rule_key, verdict: r.verdict, matcher: r.matcher }));

function verdict(text: string): string {
  const c = classifyComment({ text, attachments: [] }, RULES);
  if (!c.ok) throw new Error(c.detail);
  return c.verdict;
}

test('DONE-TEST: the ad keywords are ALWAYS answered, whatever sits beside them', () => {
  for (const t of ['Message', 'message', 'MESSAGE', 'Combo', 'combo', 'Combo 😍', 'Гоё байна combo', 'haha message', 'Мессеж', 'Комбо'])
    assert.equal(verdict(t), 'reply', t);
});

test('questions about the products, prices, contact and joining are answered', () => {
  for (const t of [
    'Үнэ хэд вэ?', 'une hed ve', 'Дали гэж юу вэ?', 'dali gej yu ve', 'Вэбсайт хийдэг үү', 'website hiideg uu',
    'Чатбот хийж өгдөг үү?', 'AI туслах хэрэгтэй байна, яаж авах вэ?', 'Info', 'Дэлгэрэнгүй', 'Утасны дугаар өгөөч',
    'Хаана байрладаг вэ?', 'Бүртгүүлье', 'Энэ юу вэ?', 'Манай дэлгүүрт тохирох уу?', 'Хэдэн төгрөг вэ',
  ]) assert.equal(verdict(t), 'reply', t);
});

test('praise, laughs, greetings, emoji and friend tags stay silent', () => {
  for (const t of [
    'Гоё байна', 'Амжилт хүсье', 'Мундаг', 'haha', 'хахаха', '👍', '😍😍', 'Bat Erdene', 'Bold Bat энийг хар',
    'Сайн байна уу', 'Ямар гоё юм бэ', 'Баярлалаа', 'wow nice', 'хэхэ ?',
  ]) assert.notEqual(verdict(t), 'reply', t);
});

test('a complaint is escalated, never answered — even with an ad keyword beside it', () => {
  for (const t of ['Луйвар', 'ai bish huntei holbogdmoor bna', 'Мөнгөө буцааж өгөөч', 'combo луйвар'])
    assert.equal(verdict(t), 'escalate', t);
});
