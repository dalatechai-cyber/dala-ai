/**
 * Render the side-by-side comparison as Markdown, from the captured runs.
 *
 *     node scripts/bakeoff/report.mjs --run final > docs/reports/matrix-bakeoff.md
 *
 * Every reply in the output is READ FROM A CAPTURE FILE. Nothing here composes, edits or
 * summarises a Mongolian reply — the founder is doing the native read and a paraphrase in
 * this table would be the one thing that makes the read worthless.
 */
import { readFileSync } from 'node:fs';

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? undefined : process.argv[i + 1]; };
const runTag = arg('run') ?? 'final';
const dala = JSON.parse(readFileSync(`scripts/bakeoff/runs/dala-${runTag}.json`, 'utf8'));
const anc = JSON.parse(readFileSync('scripts/bakeoff/baseline-ancestor.json', 'utf8'));
const set = JSON.parse(readFileSync('scripts/bakeoff/testset.json', 'utf8'));

const cell = (s) => (s ?? '—').replace(/\|/g, '\\|').replace(/\n+/g, ' ⏎ ').trim();
const secs = (ms) => (ms === undefined || ms === null ? '—' : `${(ms / 1000).toFixed(1)}s`);

const P = (s) => process.stdout.write(`${s}\n`);

const all = (o) => [...Object.values(o.singles ?? {}),
  ...Object.values(o.conversations ?? {}).flatMap((c) => c.turns)];
function stat(rows, pick) {
  const v = rows.map(pick).filter((x) => typeof x === 'number' && x > 0).sort((a, b) => a - b);
  return v.length === 0 ? { p50: 0, p90: 0, max: 0, n: 0 }
    : { p50: v[Math.floor(v.length / 2)], p90: v[Math.floor(v.length * 0.9)], max: v[v.length - 1], n: v.length };
}
const dRows = all(dala).filter((r) => r.ok && !r.deterministic);
const aRows = all(anc).filter((r) => r.ok && !r.deterministic && !r.silent);
const dMs = stat(dRows, (r) => r.ms), aMs = stat(aRows, (r) => r.ms);
const dCh = stat(dRows, (r) => (r.reply ?? '').length), aCh = stat(aRows, (r) => (r.reply ?? '').length);

P('# Matrix DM bake-off — Dala AI vs the incumbent');
P('');
P(`Generated from captured runs. Dala run \`${runTag}\` (${dala.ranAt}); ancestor baseline captured ${anc.capturedAt} and never re-asked.`);
P('');
P('**Every Mongolian reply below is verbatim from the capture files.** Nothing is paraphrased, shortened or composed for this table — the native read is the point of the report.');
P('');
P('## Headline');
P('');
P('| | Dala AI (after tonight\'s fixes) | Ancestor | Dala in production last night |');
P('|---|---|---|---|');
P(`| Reply latency p50 | **${secs(dMs.p50)}** | ${secs(aMs.p50)} | 25.8s |`);
P(`| Reply latency p90 | **${secs(dMs.p90)}** | ${secs(aMs.p90)} | 51.4s |`);
P(`| Slowest reply | ${secs(dMs.max)} | ${secs(aMs.max)} | 480.7s |`);
P(`| Reply length p50 | **${dCh.p50} chars** | ${aCh.p50} chars | — |`);
P(`| Longest reply | **${dCh.max} chars** | ${aCh.max} chars | 1,020 chars |`);
P(`| Replies measured | ${dMs.n} | ${aMs.n} | 34 |`);
P('');
P('## Every test message, side by side');
P('');
P('`model` = the model answered · `canned` = a reviewed row was served · a flag in brackets is an outbound-guard refusal.');
P('');

const cases = [...set.cases, ...set.attachmentCases];
for (const c of cases) {
  const d = dala.singles[c.id]; const a = anc.singles[c.id];
  if (d === undefined && a === undefined) continue;
  P(`### \`${c.id}\` «${cell(c.text) || '(no text — attachment only)'}»`);
  P('');
  P(`*Expected:* ${c.expect}`);
  P('');
  P('| | reply | time |');
  P('|---|---|---|');
  const flags = (d?.flags ?? []).length > 0 ? ` _[${d.flags.join(', ')}]_` : '';
  P(`| **Dala** (${d?.answeredBy ?? '—'}) | ${cell(d?.ok ? d.reply : `ERROR: ${d?.error}`)}${flags} | ${secs(d?.ms)} |`);
  P(`| **Ancestor** | ${cell(a?.silent ? '(silent — sticker dropped)' : a?.ok ? a.reply : `ERROR: ${a?.error}`)} | ${secs(a?.ms)} |`);
  P('');
}

P('## The 11-turn thread');
P('');
P('This is the conversation that produced walls of text in production: replies grew 37 → 1,020 characters because the assistant\'s own turns never reached the model (D-111).');
P('');
for (const conv of set.conversations) {
  const d = dala.conversations[conv.id]; const a = anc.conversations[conv.id];
  if (d === undefined) continue;
  P('| # | customer | Dala | chars | time | Ancestor | chars | time |');
  P('|---|---|---|---|---|---|---|---|');
  d.turns.forEach((t, i) => {
    const at = a?.turns?.[i];
    P(`| ${i + 1} | ${cell(conv.turns[i])} | ${cell(t.ok ? t.reply : `ERROR: ${t.error}`)} | ${(t.reply ?? '').length} | ${secs(t.ms)} | ${cell(at?.ok ? at.reply : at?.error ?? '—')} | ${(at?.reply ?? '').length} | ${secs(at?.ms)} |`);
  });
  P('');
}
