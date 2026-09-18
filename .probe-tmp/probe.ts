import { classifyComment, type CommentRule } from '../src/lib/comments/classify.ts';
import { MATRIX_DM_CORPUS } from '../src/lib/comments/corpus.fixtures.ts';
import { containsStem, matchesStemSequence } from '../src/lib/mn/match.ts';
const subject = (text: string) => ({ text, attachments: [] as string[] });

const rule = (ruleKey: string, verdict: CommentRule['verdict'], stems: string[]): CommentRule =>
  ({ ruleKey, verdict, matcher: { mode: 'contains_stem', stems } });
const seq = (ruleKey: string, verdict: CommentRule['verdict'], stems: string[], windowCp = 14): CommentRule =>
  ({ ruleKey, verdict, matcher: { mode: 'stem_sequence', stems, windowCp } });

/**
 * A rule set in the shape a salon operator would actually write, and the one
 * `docs/comments.md` measured. Cyrillic and the romanised spellings side by side (D-067).
 *
 * Note the two SEQUENCES, and that they are not an optimisation. Mongolian's two most
 * commercially important words here are both three characters — «цаг» (*appointment*) and
 * «хэд» (*how much*) — and both are correctly refused by `MIN_STEM_CHARS`, because «цаг»
 * begins «цагаан» (white) and «хэд» begins «хэдэн» but also «хэдийнээ». Without the
 * sequence mode the booking and price intents are unreachable in rows.
 */
const RULES: CommentRule[] = [
  rule('complaint', 'escalate', ['утсаа', 'залга', 'хүнтэй', 'huntei', 'holbogdmoor', 'tuvshnii', 'ai bish']),
  rule('price', 'reply', ['хэдэ', 'төлбөр', 'tulbur', 'hymdral', 'хямдрал', 'үнэ ', 'үний']),
  seq('price_mn', 'reply', ['хэд', 'вэ'], 24),
  seq('price_lat', 'reply', ['hed', 've'], 24),
  rule('location', 'reply', ['хаяг', 'hayg', 'xayg', 'байршил', 'салбар', 'salbar', 'salbaruud']),
  rule('service', 'reply', ['хими', 'himi', 'буда', 'budal', 'budag', 'тайрал', 'tairal', 'сэттинг', 'setting',
                            'эмчилгээ', 'emchilge', 'маникюр', 'педикюр', 'үйлчилгээ', 'uilchilge',
                            'өнгө', 'ongo', 'ongi', 'сурга', 'surgalt', 'color']),
  seq('booking_mn', 'reply', ['цаг', 'ав']),
  seq('booking_lat', 'reply', ['tsag', 'av']),
  seq('booking_free_mn', 'reply', ['цаг', 'ба'], 18),
  seq('booking_free_lat', 'reply', ['tsag', 'b'], 20),
  rule('hours', 'reply', ['хуваар', 'huwaari', 'hoowari', 'ажилла']),
  rule('contact', 'reply', ['утас', 'utas', 'дугаар']),
  rule('praise', 'ignore', ['гоён', 'сайхан', 'баярла', 'bayrla', 'bayrll']),
];

const subj = (t: string) => ({ text: t, attachments: [] as string[] });
const verdictOf = (t: string, rs: CommentRule[] = RULES) => {
  const r = classifyComment(subj(t), rs);
  return r.ok ? `${r.verdict} [${r.firedRules.join(',')}]` : `REFUSED ${r.code}`;
};

console.log('=== 1. the finding\'s two probe strings ===');
for (const t of ['хэдийнээ ирэх вэ', 'hediin irhe ve', 'хэдийнээ', 'хэдийнээ ирэх']) {
  console.log(JSON.stringify(t), '->', verdictOf(t));
}

console.log('\n=== 2. is «хэдийнээ» (or any хэди-) in the real corpus? ===');
console.log(MATRIX_DM_CORPUS.filter((m) => /хэди/iu.test(m) || /hedii/iu.test(m)));

console.log('\n=== 3. what do the two price SEQUENCES uniquely rescue in the corpus? ===');
const noSeq = RULES.filter((r) => r.ruleKey !== 'price_mn' && r.ruleKey !== 'price_lat');
for (const m of MATRIX_DM_CORPUS) {
  const a = classifyComment(subj(m), RULES);
  const b = classifyComment(subj(m), noSeq);
  const av = a.ok ? a.verdict : 'REFUSED';
  const bv = b.ok ? b.verdict : 'REFUSED';
  if (av !== bv) console.log(JSON.stringify(m), `  with=${av}  without=${bv}`, a.ok ? a.firedRules : '');
}

console.log('\n=== 4. the bare-noun class the finding says the price rule cannot reach ===');
for (const t of ['Үнэ', 'үнэ', 'Хими', 'Мэдээлэл', 'Хаяг', 'Salbaruud', 'Эмэгтэй хими', 'Usnii emchilgee', 'Үс будуулах', 'Tsagiin huwaari']) {
  console.log(JSON.stringify(t), '->', verdictOf(t));
}

console.log('\n=== 5. is «Үнэ» even in the corpus, bare or otherwise? ===');
console.log(MATRIX_DM_CORPUS.filter((m) => /үн[эи]/iu.test(m)));

console.log('\n=== 6. price coverage WITHOUT any question particle ===');
for (const t of ['үнэ нь', 'үний мэдээлэл', 'хямдрал', 'төлбөр', 'tulbur', 'hymdral', 'хэдэн төгрөг']) {
  console.log(JSON.stringify(t), '->', verdictOf(t));
}

console.log('\n=== 7. the real price questions in the corpus ===');
for (const m of MATRIX_DM_CORPUS) {
  const r = classifyComment(subj(m), RULES);
  if (r.ok && r.firedRules.some((k) => k.startsWith('price'))) console.log(JSON.stringify(m), '->', r.firedRules);
}
