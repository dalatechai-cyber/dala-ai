/**
 * The one command, run end to end: `scripts/bakeoff/testset.ts` over a dump, with no model.
 * It proves the harness — set → gate → capture → report — without a key and without a
 * database; what it cannot prove is any model reply, which only a keyed run produces.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { taraDump } from './fixtures.ts';

const SET = {
  title: 'Harness', tenant_slug: 'matrix-eco-salon', note_prefix: 'harness', report: 'unused.md', sql: 'x.sql', activation_sql: 'y.sql',
  categories: { a: 'A' }, always_not: ['Матрикс'],
  cases: [
    { id: 'a01', category: 'a', source: 's', text: 'chi henbe', expect: 'The row.', expected_body: 'Сайн байна уу! Би Tara Salon-ы AI туслах байна. Хүссэн зүйлээ асуугаарай.' },
    { id: 'a02', category: 'a', source: 's', text: 'Сор хэд вэ?', expect: 'Needs the model.', must_include: ['000₮'] },
    { id: 'a03', category: 'a', source: 's', text: 'chi henbe', expect: 'Wrong on purpose.', must_include: ['DalaTech'] },
  ],
};

/** No key of any kind reaches the child: the run must decide from the flags alone. */
function env(): NodeJS.ProcessEnv {
  const e = { ...process.env };
  for (const k of ['ANTHROPIC_API_KEY', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SECRET_WORKER', 'SUPABASE_SECRET_PUBLISH']) delete e[k];
  return e;
}

function files(): { dir: string; set: string; dump: string; out: string; report: string } {
  const dir = mkdtempSync(join(tmpdir(), 'testset-'));
  const f = { dir, set: join(dir, 'set.json'), dump: join(dir, 'dump.json'), out: join(dir, 'run.json'), report: join(dir, 'report.md') };
  writeFileSync(f.set, JSON.stringify(SET));
  writeFileSync(f.dump, JSON.stringify(taraDump()));
  return f;
}

test('DONE-TEST: one command answers the set through the gate and writes the capture and the report', () => {
  const f = files();
  const r = spawnSync(process.execPath, ['--no-warnings', 'scripts/bakeoff/testset.ts',
    '--set', f.set, '--dump', f.dump, '--no-model', '--out', f.out, '--report', f.report, '--now', '2026-09-25T14:00:00+08:00'],
  { env: env(), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const run = JSON.parse(readFileSync(f.out, 'utf8')) as { results: { id: string; outcome: string; reply: string | null }[]; callsMade: number; contentHash: string };
  assert.deepEqual(run.results.map((x) => [x.id, x.outcome]), [['a01', 'pass'], ['a02', 'unchecked'], ['a03', 'wrong']]);
  assert.equal(run.callsMade, 0);
  assert.match(run.contentHash, /^[0-9a-f]{64}$/u);
  const md = readFileSync(f.report, 'utf8');
  assert.match(md, /No model answered in this run/u);
  assert.match(md, /in \('harness:a01'\)/u);
  assert.match(r.stdout, /1 pass · 1 wrong · 1 unchecked · 0 model call\(s\)/u);
});

test('with no key and no --no-model, the command refuses before it reads or calls anything', () => {
  const f = files();
  const r = spawnSync(process.execPath, ['--no-warnings', 'scripts/bakeoff/testset.ts', '--set', f.set, '--dump', f.dump, '--out', f.out, '--report', f.report],
    { env: env(), encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Nothing was called and nothing was spent/u);
});

test('a dump whose prompt does not hash to its snapshot is refused, not measured', () => {
  const f = files();
  const d = taraDump();
  const snap = d['config_snapshots']?.[0];
  assert.ok(snap !== undefined);
  snap['prompt_stable'] = `${String(snap['prompt_stable'])} `;
  writeFileSync(f.dump, JSON.stringify(d));
  const r = spawnSync(process.execPath, ['--no-warnings', 'scripts/bakeoff/testset.ts', '--set', f.set, '--dump', f.dump, '--no-model', '--out', f.out, '--report', f.report],
    { env: env(), encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /refusing to measure something else/u);
});
