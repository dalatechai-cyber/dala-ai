/**
 * Парк Од's Дали covers every kind of message Яармаг's does (founder, 2026-10-05: «for every
 * kind of message and comment that Яармаг's tests cover, there must be an equivalent for
 * her»). Reads the provision files only; the behaviour itself is proven on a replica by the
 * publish dry run (her reply cases) and `scripts/verify/branch-parity.ts` (the worker, end to
 * end). This file keeps the two from drifting apart: a new Яармаг file of reply cases fails
 * here until it has a Парк Од equivalent or a written reason why not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const dir = new URL('./', import.meta.url);
const read = (f: string): string => readFileSync(new URL(f, dir), 'utf8');
const PARITY = 'tara-park-od-parity-2026-10-05.sql';
const AFTER = 'tara-park-od-after-onboarding.sql';

/**
 * Each of Яармаг's reply-case files, and where Парк Од's equivalent lives: the file and a
 * string that file must contain. `null` = no equivalent, with the reason.
 */
const EQUIVALENT: Record<string, { file: string; marker: string } | { none: string }> = {
  'chat-forms-2026-09-27.sql': { file: PARITY, marker: "'sain bnu uu', 'det', 'greeting'" },
  'tara-thanks-2026-09-27.sql': { file: PARITY, marker: "'bayarlalaa', 'det', 'thanks'" },
  'media-notice-tara-rename-2026-09-27.sql': { none: 'Matrix\'s rename to Tara: Парк Од was never Matrix (no tara_name row)' },
  'tara-fixed-replies-2026-09-30.sql': { file: PARITY, marker: "'Утас хэд вэ', 'det', 'salon_phone'" },
  'tara-branch-count-2026-10-01.sql': { file: PARITY, marker: "'hed salbartai ve', 'det', 'branch_count'" },
  'tara-branches-2026-10-01.sql': { file: PARITY, marker: "'Яармаг салбар хаана байдаг вэ?', 'det', 'yarmag_branch'" },
  'tara-stylist-levels-2026-10-01.sql': { file: PARITY, marker: "'SPECIAL үсчин', 'det', 'stylist_tier'" },
  'tara-price-list-2026-10-01.sql': { file: PARITY, marker: "'8 настай хүүгийн үс тайралт хэд вэ?', 'model'" },
  'tara-dali-quality-2026-10-03.sql': { none: 'its five model cases are not on Яармаг\'s live rows (read 2026-10-05: 78 cases, none «quality 2026-10-03»)' },
  'tara-yarmag-answers-2026-10-04.sql': { file: AFTER, marker: "answers 2026-10-04 (exact): the dye brand" },
  'tara-yarmag-colour-and-treatment-perm-2026-10-04.sql': { file: AFTER, marker: 'D-177: «өнгө гаргалт» from a man' },
  'tara-yarmag-deposit-and-level-2026-10-04.sql': { file: AFTER, marker: 'deposit and level 2026-10-04 (exact)' },
  'tara-yarmag-photo-question-2026-10-04.sql': { file: PARITY, marker: "@canned:photo_price_question\"}]', 'hed ve', 'canned', 'handover_notice'" },
  'tara-yarmag-reel-question-2026-10-04.sql': { file: PARITY, marker: "'https://www.facebook.com/share/r/1AbCdEfGh/', 'canned', 'reel_price_question'" },
  // A proposal (2026-10-08, awaiting the founder's go): case 162 corrected as her case is, and four
  // price twins whose Парк Од originals are her onboarding cases (`generateCases`, «onboard:price_N»);
  // the marker proves the deposit half only.
  'tara-yarmag-price-twins-2026-10-08.sql': { file: 'tara-park-od-deposit-case-2026-10-08.sql', marker: `set must_include = '{"20,000₮"}'::text[]` },
};

test('every Яармаг file of reply cases has a Парк Од equivalent, or a reason', () => {
  const yarmag = readdirSync(dir).filter((f) => f.endsWith('.sql') && !f.endsWith('-revert.sql') && !f.startsWith('tara-park-od')
    && /insert into reply_cases/i.test(read(f)) && read(f).includes("'matrix-eco-salon'"));
  assert.ok(yarmag.length >= 14, `found only ${yarmag.length} of Яармаг's files`);
  for (const f of yarmag) assert.ok(f in EQUIVALENT, `${f} inserts Яармаг reply cases and has no Парк Од equivalent listed here`);
  for (const [f, eq] of Object.entries(EQUIVALENT)) {
    if ('none' in eq) continue;
    assert.ok(read(eq.file).includes(eq.marker), `${f}: «${eq.marker}» is not in ${eq.file}`);
  }
});

test('the live cases with no provision file (2026-09-24/25) are mirrored too', () => {
  const p = read(PARITY);
  for (const m of ["'usnii himi', 'lit'", "'us bish usnii himi', 'lit'", "'ci henbe', 'det', 'assistant_who'",
    "'cmg hen hiisen be', 'det', 'assistant_maker'", "'Hi margaash tanaih ajilahu', 'model'",
    'Баярын өдрийн цагийг 99076874 дугаараас лавлана уу.']) {
    assert.ok(p.includes(m), `parity file lacks ${m}`);
  }
});

test('her comment rules are exactly the salon template the comment tests prove', () => {
  const template = (JSON.parse(read('templates/comment_rules.salon.json')) as { rules: { rule_key: string }[] }).rules.map((r) => r.rule_key);
  const m = /update comment_rules set enabled = true[\s\S]*?rule_key in \(([\s\S]*?)\);/.exec(read(PARITY));
  assert.ok(m !== null, 'the parity file switches no comment rules on');
  const keys = [...m[1]!.matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]);
  assert.deepEqual([...keys].sort(), [...template].sort());
  assert.match(read(PARITY), /comment_delivery_mode = 'shadow'/, 'comments start in shadow');
});

test('her photo and reel questions are Яармаг\'s approved bytes', () => {
  const p = read(PARITY);
  const reel = /\('reel_price_question', '([^']+)'\)/.exec(p)?.[1];
  assert.ok(reel !== undefined && read('tara-yarmag-reel-question-2026-10-04.sql').includes(`'${reel}'`), 'reel question differs from Яармаг\'s');
  const photo = /\('photo_price_question', '([^']+)'\),/.exec(p)?.[1];
  // Яармаг's photo question is her image_received line, which Парк Од carries byte for byte.
  assert.ok(photo !== undefined && read(AFTER).includes(`('image_received', '${photo}')`), 'photo question differs from her image_received line');
});

test('nothing of Яармаг\'s branch in what her parity rows say', () => {
  const lines = read(PARITY).split('\n').filter((l) => !l.trimStart().startsWith('--'));
  for (const l of lines) {
    if (!/76001888|91005498|Номин Хайпермаркет/.test(l)) continue;
    // Only inside a case's must-not-include list ('{…}'), or in the read-back that checks for them.
    const outsideLists = l.replace(/'\{[^']*\}'/g, '').replace(/~ '76001888\|91005498'/, '');
    assert.ok(!/76001888|91005498|Номин Хайпермаркет/.test(outsideLists), `Яармаг detail in: ${l.trim().slice(0, 120)}`);
  }
});

test('Парк Од never quotes the SPECIAL men\'s cut (founder, 2026-10-08: Tuchku is Мастер)', () => {
  const groups = JSON.parse(readFileSync(new URL('../../config/branch-groups.json', import.meta.url), 'utf8')) as
    Record<string, { not_offered?: Record<string, unknown[]> }>;
  const off = groups['tara-salon']?.not_offered?.['tara-park-od'] ?? [];
  assert.ok(off.some((v) => JSON.stringify(v) === JSON.stringify({ service: 'Эрэгтэй тайралт', variant: 'SPECIAL' })),
    'config/branch-groups.json must mark her SPECIAL men\'s cut as not offered');
  const answers = JSON.parse(readFileSync(new URL('../../intake/tara-park-od.answers.json', import.meta.url), 'utf8')) as unknown;
  const row = JSON.stringify(answers).match(/\["Эрэгтэй тайралт","([^"]*)"/u)?.[1];
  assert.equal(row, '69,000₮', 'her form carries only the 69,000₮ men\'s cut');
  assert.ok(read(PARITY).includes("'Эрэгтэй тайралт хэд вэ?', 'model', null, '{\"69,000₮\"}', '{SPECIAL}'"),
    'her reply case for the men\'s cut is in the parity file');
});
