/**
 * Score two `arms.ts` runs side by side on the founder's six questions, as Markdown.
 *
 *     node scripts/bakeoff/compare.mjs --a sonnet-night1 --b egune-night1 \
 *       [--b-usd-in 0.5 --b-usd-out 1.5]   # Egune's price per MILLION tokens, when known
 *       > docs/reports/<date>-egune-vs-sonnet.md
 *
 * What it can and cannot measure, stated so the table is not read as more than it is:
 *
 *  - FACTS AND PRICES — measured two ways. The permanent cases (`reply_cases`) are judged by
 *    the gate's own `judge()` against the founder's expected answer. Everywhere else, the
 *    proxy is the guards: a model reply the pipeline DISCARDED (outbound guard, facts guard,
 *    pinned-line check) and replaced with a reviewed row is a reply that stated something the
 *    data does not support, or broke a rule the guard enforces. That is a lower bound on wrong
 *    facts, not a count of them — a wrong fact the guards cannot see passes both arms alike.
 *  - LATIN-TYPED MONGOLIAN — the same measures, restricted to messages written mostly in Latin
 *    letters.
 *  - NATURAL MONGOLIAN — NOT measurable by a script, and this does not pretend to. It reports
 *    mechanical symptoms only (script share, foreign-script leakage, reasoning traces) and
 *    prints every reply verbatim for the native read, which is the actual test.
 *  - STYLE — the checkable rules of the signed `02_style` block, on the MODEL's own text:
 *    markdown (** # • leading dash, HTML), more than three sentences outside price lines.
 *  - SPEED — per model call, and against the production timeout (25 s), past which the
 *    customer gets the handoff line instead of the reply.
 *  - COST — from each call's own usage. Sonnet 5 at the registry's prices; Egune only when its
 *    price is given, because no official price was readable when this was written.
 */
import { readFileSync } from 'node:fs';

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? undefined : process.argv[i + 1]; };
const load = (tag) => JSON.parse(readFileSync(`scripts/bakeoff/runs/${tag}.json`, 'utf8'));
const A = load(arg('a') ?? 'sonnet-run');
const B = load(arg('b') ?? 'egune-run');
const models = JSON.parse(readFileSync('config/models.json', 'utf8'));
const FX = Number(arg('fx') ?? 3500); // MNT per USD, the rate spend_ledger records.
// Tara's measured model calls per month (spend_ledger, 14 days to 2026-09-25): 217 calls, 10
// active days. Low = over the whole window, high = over active days only. D-016's 60.5
// replies/day is the incumbent's older, busier measure.
const VOLUMES = [['current, low', 465], ['current, high', 651], ['D-016 (60.5/day)', 1842]];
const TIMEOUT_MS = 25_000;

const P = (s = '') => process.stdout.write(`${s}\n`);
const pct = (n, d) => (d === 0 ? '—' : `${Math.round((100 * n) / d)}%`);
const q = (xs, p) => { const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); return v.length === 0 ? NaN : v[Math.min(v.length - 1, Math.floor(p * v.length))]; };
const s1 = (ms) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : '—');
const cell = (s) => (s ?? '—').replace(/\|/g, '\\|').replace(/\n+/g, ' ⏎ ').trim();

const letters = (s) => [...s].filter((c) => /\p{L}/u.test(c));
const latinShare = (s) => { const l = letters(s); return l.length === 0 ? 0 : l.filter((c) => /\p{Script=Latin}/u.test(c)).length / l.length; };
const cyrShare = (s) => { const l = letters(s); return l.length === 0 ? 0 : l.filter((c) => /\p{Script=Cyrillic}/u.test(c)).length / l.length; };
const FOREIGN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Arabic}\p{Script=Thai}]/u;
const PRICE_LINE = /\d[\d,.\s]*₮/u;

/** The checkable `02_style` rules, on the model's own text. */
function styleBreaks(text) {
  const out = [];
  if (/\*\*|^#|•|<\/?[a-z][^>]*>/imu.test(text) || /^\s*-\s/mu.test(text)) out.push('markdown');
  const prose = text.split('\n').filter((l) => !PRICE_LINE.test(l)).join(' ');
  const sentences = prose.split(/(?<=[.!?])\s+/u).filter((x) => letters(x).length > 2);
  if (sentences.length > 3) out.push('over 3 sentences');
  return out;
}

function priceOf(model) {
  if (model.startsWith('claude-')) {
    const p = models.prices[model];
    if (p === undefined) return null;
    return (u) => ((u.input_tokens ?? 0) * p.in + (u.output_tokens ?? 0) * p.out
      + (u.cache_read_input_tokens ?? 0) * p.cacheRead + (u.cache_creation_input_tokens ?? 0) * p.cacheWrite1h) / 1e9;
  }
  const inP = Number(arg('b-usd-in')); const outP = Number(arg('b-usd-out'));
  if (!Number.isFinite(inP) || !Number.isFinite(outP)) return null;
  return (u) => ((u.input_tokens ?? 0) * inP + (u.output_tokens ?? 0) * outP) / 1e6;
}

function score(run) {
  const rs = run.results;
  const calls = rs.flatMap((r) => r.calls ?? []);
  const reached = rs.filter((r) => (r.calls ?? []).length > 0);
  const modelOk = reached.filter((r) => r.calls.some((c) => c.kind === 'ok'));
  const served = reached.filter((r) => r.answeredBy === 'model');
  const replaced = modelOk.filter((r) => r.answeredBy !== 'model');
  const failedCall = reached.filter((r) => !r.calls.some((c) => c.kind === 'ok'));
  const latin = reached.filter((r) => latinShare(r.text) >= 0.5);
  const texts = calls.filter((c) => c.kind === 'ok' && typeof c.text === 'string').map((c) => c.text);
  const price = priceOf(run.model);
  const costs = price === null ? [] : calls.filter((c) => c.usage).map((c) => price(c.usage));
  const judged = rs.filter((r) => r.judged);
  const flags = {};
  for (const r of replaced) for (const f of r.flags ?? []) flags[f] = (flags[f] ?? 0) + 1;
  return {
    run, rs, calls, reached, served, replaced, failedCall, latin, texts, judged, flags,
    latinServed: latin.filter((r) => r.answeredBy === 'model'),
    latinReplaced: latin.filter((r) => r.calls.some((c) => c.kind === 'ok') && r.answeredBy !== 'model'),
    ms: calls.filter((c) => c.kind === 'ok').map((c) => c.ms),
    timeouts: calls.filter((c) => c.ms >= TIMEOUT_MS || c.reason === 'timeout').length,
    style: texts.map(styleBreaks),
    cyr: texts.map(cyrShare),
    foreign: texts.filter((t) => FOREIGN.test(t)).length,
    think: calls.filter((c) => c.egune?.thinkStripped).length,
    lengths: texts.map((t) => [...t].length),
    inTok: calls.filter((c) => c.usage).map((c) => (c.usage.input_tokens ?? 0) + (c.usage.cache_read_input_tokens ?? 0) + (c.usage.cache_creation_input_tokens ?? 0)),
    outTok: calls.filter((c) => c.usage).map((c) => c.usage.output_tokens ?? 0),
    costPerCall: costs.length === 0 ? NaN : costs.reduce((a, b) => a + b, 0) / costs.length,
  };
}

const a = score(A); const b = score(B);
const name = (r) => `${r.arm} (\`${r.model}\`)`;
const row = (label, f) => P(`| ${label} | ${f(a)} | ${f(b)} |`);
const usd = (x) => (Number.isFinite(x) ? `$${x.toFixed(4)}` : 'price unknown');

P(`# ${A.arm} vs ${B.arm} — Tara Salon, prompt \`${String(A.contentHash).slice(0, 12)}\``);
P();
if (A.contentHash !== B.contentHash) P(`> **The two runs used DIFFERENT prompts** (\`${String(A.contentHash).slice(0, 12)}\` vs \`${String(B.contentHash).slice(0, 12)}\`). Nothing below is a like-for-like comparison.\n`);
P(`Runs: \`${A.arm}\` ${A.ranAt}, \`${B.arm}\` ${B.ranAt}. Both answered as of ${A.now}. ${a.rs.length} messages each; ${a.reached.length} / ${b.reached.length} reached the model (the rest were answered by deterministic rows before any model).`);
P();
P(`| | ${name(A)} | ${name(B)} |`);
P('|---|---|---|');
P('| **1. Facts and prices** | | |');
row('Permanent cases passed', (s) => `${s.judged.filter((r) => r.pass).length} / ${s.judged.length}`);
row('Permanent cases that reached the model', (s) => `${s.judged.filter((r) => (r.calls ?? []).length > 0).length}`);
row('Model replies served as written', (s) => `${s.served.length} / ${s.reached.length} (${pct(s.served.length, s.reached.length)})`);
row('Model replies DISCARDED by a guard', (s) => `${s.replaced.length} (${pct(s.replaced.length, s.reached.length)})`);
row('— why (flags)', (s) => cell(Object.entries(s.flags).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'));
row('No usable model reply (error / timeout)', (s) => `${s.failedCall.length}`);
P('| **2. Latin-typed Mongolian** | | |');
row('Messages mostly in Latin letters', (s) => `${s.latin.length}`);
row('— served as written', (s) => `${s.latinServed.length} (${pct(s.latinServed.length, s.latin.length)})`);
row('— discarded by a guard', (s) => `${s.latinReplaced.length}`);
P('| **3. Natural Mongolian** (symptoms only — see the native read below) | | |');
row('Cyrillic share of letters, median', (s) => pct(q(s.cyr, 0.5) * 100, 100));
row('Replies with CJK/other foreign script', (s) => `${s.foreign}`);
row('Replies with a reasoning trace stripped', (s) => `${s.think}`);
P('| **4. Style (signed 02_style)** | | |');
row('Markdown in the model\'s text', (s) => `${s.style.filter((x) => x.includes('markdown')).length} / ${s.texts.length}`);
row('Over 3 sentences outside price lines', (s) => `${s.style.filter((x) => x.includes('over 3 sentences')).length} / ${s.texts.length}`);
row('Length p50 / p90 (chars)', (s) => `${q(s.lengths, 0.5)} / ${q(s.lengths, 0.9)}`);
P('| **5. Speed** | | |');
row('Model call p50 / p90 / max', (s) => `${s1(q(s.ms, 0.5))} / ${s1(q(s.ms, 0.9))} / ${s1(Math.max(...s.ms))}`);
row(`At or past the ${TIMEOUT_MS / 1000} s production timeout`, (s) => `${s.timeouts}`);
P('| **6. Cost** | | |');
row('Tokens per call in / out (median)', (s) => `${q(s.inTok, 0.5)} / ${q(s.outTok, 0.5)}`);
row('Cost per model call (this run)', (s) => usd(s.costPerCall));
for (const [label, n] of VOLUMES) row(`Per month at ${n} calls (${label})`, (s) => (Number.isFinite(s.costPerCall) ? `$${(s.costPerCall * n).toFixed(2)} ≈ ₮${Math.round(s.costPerCall * n * FX).toLocaleString('en-US')}` : '—'));
P();
P('Sonnet 5\'s cost in a bake-off reads a warm cache; production\'s measured figure (spend_ledger, 217 calls to 2026-09-25) is **$0.0116 per call** with 80.6% cache hits, and is the one to plan with.');
P();
P('## Every reply, verbatim, for the native read');
P();
P('`served` is what the customer would get. `model wrote` is shown only where a guard discarded it.');
P();
const byId = new Map(b.rs.map((r) => [r.id, r]));
for (const ra of a.rs) {
  const rb = byId.get(ra.id);
  if ((ra.calls ?? []).length === 0 && (rb?.calls ?? []).length === 0) continue;
  P(`### \`${ra.id}\` «${cell(ra.text)}»${ra.expect ? ` — *${cell(ra.expect)}*` : ''}`);
  P();
  P('| | reply | by | time |');
  P('|---|---|---|---|');
  for (const [label, r] of [[A.arm, ra], [B.arm, rb]]) {
    if (r === undefined) { P(`| ${label} | — | — | — |`); continue; }
    const call = (r.calls ?? []).find((c) => c.kind === 'ok');
    const fl = (r.flags ?? []).length ? ` _[${r.flags.join(', ')}]_` : '';
    P(`| **${label}** served | ${cell(r.ok ? r.reply : `ERROR: ${r.error}`)}${fl} | ${r.answeredBy ?? '—'} | ${s1(call?.ms)} |`);
    if (call && r.answeredBy !== 'model') P(`| ${label} model wrote | ${cell(call.text)} | | |`);
  }
  P();
}
