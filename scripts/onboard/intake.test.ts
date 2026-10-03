/**
 * Every client form prepared in this repository (`intake/<slug>.answers.json`, built into
 * `intake/<slug>.docx` by `scripts/onboard/fixtures/fill.ts`) reads back whole: each row the
 * answers hold is in the form the onboarding command reads, and every price row parses.
 *
 * Here and not under src/: these are real tenants' forms, and src/ carries no tenant
 * (CLAUDE.md, «a client is rows»). A form edited without rebuilding its .docx fails here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { formBlocks } from '../../src/lib/provision/formFile.ts';
import { readQuestionnaire } from '../../src/lib/provision/questionnaire.ts';
import { planFromForm, type Templates } from '../../src/lib/provision/plan.ts';

const templates = JSON.parse(readFileSync('scripts/provision/templates/onboarding.mn.json', 'utf8')) as Templates;
const forms = readdirSync('intake').filter((f) => f.endsWith('.answers.json')).sort();

test('there is at least one prepared form to check', () => {
  assert.ok(forms.length > 0);
});

for (const answersFile of forms) {
  const slug = answersFile.replace(/\.answers\.json$/u, '');
  test(`intake/${slug}: every answered row is read back from intake/${slug}.docx, every price parses`, () => {
    const docx = `intake/${slug}.docx`;
    assert.ok(existsSync(docx), `${docx} is missing: rebuild it with fixtures/fill.ts`);
    const want = JSON.parse(readFileSync(`intake/${answersFile}`, 'utf8')) as {
      tables: { services: string[][]; staff: string[][]; faqs: string[][] };
    };
    const r = readQuestionnaire(formBlocks(docx, readFileSync(docx)));
    assert.ok(r.ok, JSON.stringify(!r.ok && r.problems));
    const a = r.answers;
    const norm = (x: string) => x.replace(/\s+/gu, ' ').trim();
    const rowsOf = (t: string[][]) => t.map((row) => norm(row.map(norm).join(' | ')));
    assert.deepEqual(a.services.map((s) => norm([s.name, s.price, s.duration, s.note].join(' | '))), rowsOf(want.tables.services));
    assert.deepEqual(a.staff.map((s) => norm([s.name, s.grade, s.branch, s.active].join(' | '))), rowsOf(want.tables.staff));
    assert.deepEqual(a.faqs.map((f) => norm([f.question, f.answer].join(' | '))), rowsOf(want.tables.faqs));
    const plan = planFromForm(a, { slug, templates });
    assert.equal(plan.intake.services.length, want.tables.services.length, 'every price row became a service');
    assert.deepEqual(plan.missing.filter((m) => m.code === 'price' || m.code === 'price_unreadable').map((m) => m.what), []);
  });
}
