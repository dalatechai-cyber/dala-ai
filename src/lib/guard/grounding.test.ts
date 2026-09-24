import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverage, tenantRegion, ungroundedSentences } from './grounding.ts';

// The salon's own document, as the compiled prefix carries it (Matrix, seq 13).
const KB = `=== ТАНИЛЦУУЛГА ===
- Химийн хориглох заалт
Цайруулсан үсэнд хими хийхгүй. Уураг нь будагтай урвалд орж, барьцалддаг.
Будсан үс хэт цайруулаагүй, уураг нь хадгалагдсан бол хими хийж болно.
- Сор, Оффис колор, омбре
Оффис колор бол арга барил: 30 хувийн цайруулалт, малгай, дараа нь үндсийг сүүдэрлэж, үзүүрийг цайвар будгаар гэрэлтүүлнэ.
=== ҮНИЙН ЖАГСААЛТ ===
- Оффис колор: 380,000₮–460,000₮`;

test('DONE-TEST: c07 IS THE SALON\'S OWN DOCUMENT, SO IT STANDS', () => {
  // Real reply, 2026-09-24, to «Budagtai usend himi hiidegv».
  const reply = 'Будсан үс хэт цайруулаагүй, уураг нь хадгалагдсан бол хими хийж болно. '
    + 'Цайруулсан үсэнд хими хийхгүй, учир нь уураг нь будагтай урвалд орж барьцалддаг.';
  assert.deepEqual(ungroundedSentences(reply, KB), []);
});

test('DONE-TEST: c02 SAYS SOMETHING NO ROW SAYS, AND IS CAUGHT', () => {
  // Real reply, 2026-09-24, to «Office color ungu har usni ungute usend orohu».
  const reply = 'Оффис колор нь харанхуй/хар үсэнд хийхэд тохирдог арга бөгөөд үнэ нь 380,000₮–460,000₮ байна.';
  assert.equal(ungroundedSentences(reply, KB).length, 1);
});

test('a price row the list carries is grounded; a short sentence is not judged', () => {
  assert.deepEqual(ungroundedSentences('Оффис колор: 380,000₮–460,000₮\nТийм.', KB), []);
});

test('coverage counts only runs of twelve or more, so shared short words ground nothing', () => {
  assert.equal(coverage('хар үс хими', 'хар үс хими'), 0, 'eleven characters is below the run');
  assert.equal(coverage('цайруулсан үсэнд хими', 'цайруулсан үсэнд хими'), 1);
});

test('the corpus is the tenant region only — the gate blocks ground nothing', () => {
  const prefix = `Ш5 Эрүүл мэндийн зөвлөгөө бүү өг.\n=== МАРКЕР ===\n${KB}`;
  assert.ok(!tenantRegion(prefix, 'МАРКЕР').includes('Ш5'));
  assert.equal(tenantRegion(prefix, 'БАЙХГҮЙ'), '');
});
