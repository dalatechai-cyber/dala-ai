import { classifyComment, type CommentRule } from '../src/lib/comments/classify.ts';
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
const v = (t: string, rs: CommentRule[] = RULES) => { const r = classifyComment(subj(t), rs); return r.ok ? `${r.verdict} [${r.firedRules.join(',')}]` : `REFUSED ${r.code}`; };

console.log('=== A. the exact parallel comments.md:110 draws, by execution ===');
console.log('bare over-match word, booking: «цагаан»   seq[цаг,ав] fires?', matchesStemSequence('цагаан', ['цаг','ав'], 14));
console.log('bare over-match word, price:   «хэдийнээ» seq[хэд,вэ] fires?', matchesStemSequence('хэдийнээ', ['хэд','вэ'], 24));
console.log('the documented residual, booking: «цагаан авна» ->', matchesStemSequence('цагаан авна', ['цаг','ав'], 14));
console.log('the same residual, price:        «хэдийнээ ирэх вэ» ->', matchesStemSequence('хэдийнээ ирэх вэ', ['хэд','вэ'], 24));

console.log('\n=== B. does the bare stem the floor refuses behave differently? ===');
console.log('containsStem(«хэдийнээ», «хэд») =', containsStem('хэдийнээ', 'хэд'), ' <- what a bare `хэд` row would do');
console.log('containsStem(«цагаан будаг», «цаг») =', containsStem('цагаан будаг', 'цаг'));

console.log('\n=== C. the price topic WITHOUT the sequences — is it narrowed to questions? ===');
const noSeq = RULES.filter((r) => !r.ruleKey.startsWith('price_'));
for (const t of ['үнэ нь ямар', 'үний мэдээлэл', 'хямдрал байна', 'төлбөр', 'хэдэн төгрөг', 'tulbur', 'hymdral']) {
  console.log(JSON.stringify(t), ' all rules ->', v(t), '| sequences removed ->', v(t, noSeq));
}

console.log('\n=== D. what the sequence uniquely LABELS in the corpus (price intent) ===');
for (const t of ['Мөрнөөс арай богино тайруулаад сэттинг хийлгэвэл хэд болох вэ', 'Sn bnu sortoi budalt hed ve']) {
  console.log(JSON.stringify(t), '\n   all ->', v(t), '\n   no price sequences ->', v(t, noSeq));
}

console.log('\n=== E. is «цаг,ав» really the only worked example? the other sequence second-stems ===');
console.log(RULES.filter((r) => (r.matcher as any).mode === 'stem_sequence').map((r) => `${r.ruleKey}: ${JSON.stringify((r.matcher as any).stems)} win=${(r.matcher as any).windowCp}`));
console.log('«Өнөөдрийн цаг байнуу» ->', v('Өнөөдрийн цаг байнуу'));
console.log('«Sn bnu hagsaind tsag bgayu» ->', v('Sn bnu hagsaind tsag bgayu'));

console.log('\n=== F. does a question particle ALONE reach a reply? (the "narrowed to question-shape" claim) ===');
for (const t of ['вэ', 'Сайн байна уу', 'юу вэ', 'Уу', 'ве']) console.log(JSON.stringify(t), '->', v(t));
