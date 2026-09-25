/**
 * Re-render a test set's report from a captured run, without answering anything again.
 *
 *     node scripts/bakeoff/testset-report.ts --run scripts/bakeoff/runs/testset-dalatech-first-read.json \
 *       [--set scripts/bakeoff/dalatech-set.json] [--out docs/reports/dalatech-testset.md]
 *
 * `testset.ts` already writes the report at the end of a run; this exists so a change to the
 * report's layout, or to a case's `expect` line, does not cost a second run and a second
 * bill. Every reply is read from the capture file — nothing here calls a model.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { renderReport, type Run } from '../replycases/set.ts';
import { loadSet } from '../replycases/sql.ts';

const arg = (n: string): string | undefined => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const runFile = arg('run');
if (runFile === undefined) {
  process.stderr.write('usage: node scripts/bakeoff/testset-report.ts --run <run.json> [--set <set.json>] [--out <report.md>]\n');
  process.exit(2);
}
const set = loadSet(arg('set') ?? 'scripts/bakeoff/dalatech-set.json');
const run = JSON.parse(readFileSync(runFile, 'utf8')) as Run;
if (run.tenant !== set.tenantSlug) {
  process.stderr.write(`testset-report: ${runFile} is a run for «${run.tenant}», the set is for «${set.tenantSlug}»\n`);
  process.exit(2);
}
const out = arg('out') ?? set.report;
writeFileSync(out, renderReport(set, run, { runFile, generator: 'scripts/bakeoff/testset-report.ts' }));
process.stdout.write(`wrote ${out}\n`);
