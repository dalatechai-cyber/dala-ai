#!/usr/bin/env node
// Reception model bake-off. Settles DECISIONS.md D-009.
//
// Two arms on the REAL Matrix prefix and the six seeded probe prompts:
//   D  claude-sonnet-5    the incumbent (salonBrain.js:19)
//   E  claude-haiku-4-5   half the price, IF its 4096-token cache minimum is cleared
//
// What it measures, none of it estimated:
//   * input/output/cache tokens from the real `usage` block on every call
//   * cost per reply from the same prices seeded into model_prices
//   * WHETHER CACHING ACTUALLY ENGAGED — below 4096 tokens cache_control is ignored
//     with no error, and that silence is the whole economic question for Haiku
//   * one mechanical quality gate: the price_unlisted probe must emit no price
//
// Mongolian naturalness is NOT judged here. Replies are printed and written to the
// results file for a native speaker. A script cannot settle that and should not
// pretend to.
//
// Spending is bounded twice: a projected cost is computed before the first call and
// refuses if it exceeds --max-usd, and the running total is checked before every
// call thereafter. Default ceiling $0.50.
import fs from 'node:fs';
import { buildMatrixPrefix, describe, DEFAULT_ANCESTOR } from './prefix.mjs';

const API = 'https://api.anthropic.com/v1/messages';
const COUNT = 'https://api.anthropic.com/v1/messages/count_tokens';

// nano-USD per token, identical to the model_prices seed in 0001.
const PRICES = {
  'claude-sonnet-5':  { in: 2000, out: 10000, cacheRead: 200, cacheWrite1h: 4000, minCacheable: 1024 },
  'claude-haiku-4-5': { in: 1000, out:  5000, cacheRead: 100, cacheWrite1h: 2000, minCacheable: 4096 },
};
const ARMS = [
  { id: 'D', model: 'claude-sonnet-5'  },
  { id: 'E', model: 'claude-haiku-4-5' },
];

// The six probes seeded into probe_templates by 0001.
const PROBES = [
  { key: 'price_unlisted',      text: 'Хүүхдийн үс засуулах хэд вэ?',        blocking: true,  noPrice: true },
  { key: 'booking_confirm',     text: 'Маргааш 3 цагт цаг авмаар байна',     blocking: true  },
  { key: 'staff_availability',  text: 'Оюунсүрэн маргааш ажиллах уу?',       blocking: true  },
  { key: 'health_question',     text: 'Энэ будаг жирэмсэн үед аюулгүй юу?',  blocking: true  },
  { key: 'abuse',               text: 'Новш юм ярьж байна, хэрэггүй бот',    blocking: true  },
  { key: 'unknown_topic',       text: 'Та нар машин засдаг уу?',             blocking: false },
];

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const has  = (n) => argv.includes(`--${n}`);

const DRY      = has('dry-run');
const REPEATS  = Number(flag('repeats', 3));
const MAX_USD  = Number(flag('max-usd', 0.50));
const ANCESTOR = flag('ancestor', DEFAULT_ANCESTOR);
const OUT      = flag('out', 'bakeoff-results.json');

const key = process.env.ANTHROPIC_API_KEY;
if (!key) {
  console.error('ANTHROPIC_API_KEY is not set. It is read from the environment only — never pass it as an argument.');
  process.exit(2);
}

const usd = (nano) => nano / 1e9;
const fmt = (n) => `$${n.toFixed(5)}`;

async function post(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(j).slice(0, 400)}`);
  return j;
}

function costNano(model, u) {
  const p = PRICES[model];
  return (u.input_tokens || 0) * p.in
       + (u.output_tokens || 0) * p.out
       + (u.cache_read_input_tokens || 0) * p.cacheRead
       + (u.cache_creation_input_tokens || 0) * p.cacheWrite1h;
}

const prefix = await buildMatrixPrefix(ANCESTOR);
console.log(`prefix: ${JSON.stringify(describe(prefix))}\n`);

// --- free: token counts, and the Haiku cliff -------------------------------
const counts = {};
for (const { model } of ARMS) {
  const j = await post(COUNT, { model, system: prefix, messages: [{ role: 'user', content: PROBES[0].text }] });
  counts[model] = j.input_tokens;
  const min = PRICES[model].minCacheable;
  const cacheable = j.input_tokens >= min;
  console.log(`${model}: input_tokens=${j.input_tokens}  chars/token=${(prefix.length / j.input_tokens).toFixed(2)}`);
  console.log(`  cache minimum ${min}: ${cacheable ? 'CLEARED' : 'NOT MET — cache_control will be SILENTLY IGNORED'}`);
}
console.log();

if (DRY) { console.log('--dry-run: count_tokens only, nothing spent.'); process.exit(0); }

// --- projected cost, refused before the first call if over the ceiling -----
let projected = 0;
for (const { model } of ARMS) {
  const p = PRICES[model], t = counts[model];
  const cacheable = t >= p.minCacheable;
  const first = cacheable ? t * p.cacheWrite1h : t * p.in;
  const rest  = (cacheable ? t * p.cacheRead : t * p.in) * (PROBES.length * REPEATS - 1);
  projected += usd(first + rest + PROBES.length * REPEATS * 250 * p.out);
}
console.log(`projected ≈ ${fmt(projected)} for ${ARMS.length * PROBES.length * REPEATS} calls (ceiling ${fmt(MAX_USD)})`);
if (projected > MAX_USD) {
  console.error(`REFUSED: projected cost exceeds --max-usd. Raise it deliberately or lower --repeats.`);
  process.exit(1);
}
console.log();

// --- the run ---------------------------------------------------------------
let spentNano = 0;
const results = [];

for (const arm of ARMS) {
  const p = PRICES[arm.model];
  // Reception pins thinking off. Sonnet 5 takes an explicit disabled; Haiku 4.5
  // predates the parameter, so it is omitted rather than sent.
  const thinking = arm.model === 'claude-sonnet-5' ? { type: 'disabled' } : undefined;

  for (let rep = 1; rep <= REPEATS; rep++) {
    for (const probe of PROBES) {
      if (usd(spentNano) >= MAX_USD) {
        console.error(`\nSTOPPED at ${fmt(usd(spentNano))}: ceiling reached mid-run.`);
        fs.writeFileSync(OUT, JSON.stringify({ stoppedEarly: true, results }, null, 2));
        process.exit(1);
      }

      const body = {
        model: arm.model,
        max_tokens: 700,
        system: [{ type: 'text', text: prefix, cache_control: { type: 'ephemeral', ttl: '1h' } }],
        messages: [{ role: 'user', content: probe.text }],
      };
      if (thinking) body.thinking = thinking;

      const j = await post(API, body);
      const reply = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      const u = j.usage || {};
      const c = costNano(arm.model, u);
      spentNano += c;

      // The one mechanical gate: an unlisted price must produce no price. The
      // escalation phone is the only numeral allowed through.
      let noPriceHeld = null;
      if (probe.noPrice) {
        const stripped = reply.replace(/7741[-\s]?7777/g, '');
        noPriceHeld = !/\d{3,}/.test(stripped);
      }

      results.push({
        arm: arm.id, model: arm.model, probe: probe.key, rep,
        usage: u, costUsd: usd(c),
        cacheWrote: (u.cache_creation_input_tokens || 0) > 0,
        cacheRead:  (u.cache_read_input_tokens || 0) > 0,
        noPriceHeld, stop_reason: j.stop_reason, reply,
      });

      const gate = noPriceHeld === null ? '' : noPriceHeld ? '  [no-price HELD]' : '  [no-price FAILED]';
      console.log(`${arm.id} ${arm.model} ${probe.key} r${rep}  ${fmt(usd(c))}  ` +
                  `in=${u.input_tokens} out=${u.output_tokens} cw=${u.cache_creation_input_tokens||0} cr=${u.cache_read_input_tokens||0}${gate}`);
    }
  }
}

// --- summary ---------------------------------------------------------------
console.log(`\ntotal spent: ${fmt(usd(spentNano))}\n`);
for (const arm of ARMS) {
  const rows = results.filter(r => r.arm === arm.id);
  const total = rows.reduce((s, r) => s + r.costUsd, 0);
  const cached = rows.filter(r => r.cacheRead).length;
  const failed = rows.filter(r => r.noPriceHeld === false).length;
  console.log(`arm ${arm.id} ${arm.model}: ${fmt(total / rows.length)}/reply · cache reads ${cached}/${rows.length} · no-price failures ${failed}`);
}
fs.writeFileSync(OUT, JSON.stringify({ prefix: describe(prefix), counts, results }, null, 2));
console.log(`\nreplies written to ${OUT} — Mongolian quality needs a native speaker, not this script.`);
