/**
 * Run DALA AI over the same test set, through its own real code.
 *
 *     ANTHROPIC_API_KEY=… node scripts/bakeoff/dala.ts [--only f06,f12] [--tag after-fix] [--now <ISO instant>]
 *
 * ## What is real here, and what is substituted
 *
 * REAL: `renderTenantSections` and `renderStablePrefix` (the compiler production publishes
 * with), the signed platform blocks read off disk and proven byte-identical to the
 * `prompt_blocks` rows, `renderVolatile`, the whole gate, the outbound guard, the pinned-line
 * check, and `callReceptionModel` against the same `claude-sonnet-5` with the same cache
 * mode. Nothing about how a reply is decided is reimplemented in this file, because a
 * reimplementation would measure this file rather than the bot.
 *
 * SUBSTITUTED: the database. `ReceptionDeps` is stubbed — `draft` records instead of
 * inserting, `markCalled`/`settle`/`release` are no-ops, `flag` collects. The tenant's rows
 * come from `live-kb.json`, dumped from the live project. That is the ONE seam, and it is
 * the right one: every decision under test is upstream of persistence, and pointing this at
 * the real database would write test rows into a live tenant's corpus.
 *
 * ## It cannot reach Messenger
 *
 * There is no Meta client imported and no token loaded. The reply is returned, never sent.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { handleReception, MAX_REPLY_CHARS, type ReceptionDeps } from '../../src/lib/reception/handle.ts';
import { renderTenantSections, type TenantKb } from '../../src/lib/prompt/tenant.ts';
import { renderStablePrefix, type PromptSection } from '../../src/lib/prompt/render.ts';
import { renderVolatile } from '../../src/lib/reception/volatile.ts';
import { servicesFromPrefix, sectionRows, faqAnswersFromPrefix } from '../../src/lib/quality/serviceNames.ts';
import { callReception } from '../../src/lib/model/reception.ts';
import { cannedHashOf } from '../../src/lib/prompt/sections.ts';
import { MODEL_REGISTRY } from '../../src/config/platform.ts';
import { SECTION_LABELS } from '../../src/lib/prompt/tenant.ts';
import { toDeterministic, toRules } from '../../src/lib/reception/load.ts';

const TZ = 'Asia/Ulaanbaatar';
// Read from the registry rather than written here: §6.2.6 puts a model id in exactly ONE
// file, because two copies is how a migration updates one of them and leaves the other
// silently testing the wrong model.
const MODEL = MODEL_REGISTRY.reception;
const arg = (n: string): string | undefined => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const only = arg('only')?.split(',') ?? null;
const tag = arg('tag') ?? 'run';
const NOW = arg('now');
if (NOW !== undefined && Number.isNaN(new Date(NOW).getTime())) throw new Error(`--now ${NOW} is not a date`);
// `--cache off` measures the UNCACHED cost of the same prompt. Every ordinary run here
// reads a warm 1h entry, so its latency is a like-for-like comparison figure and NOT a
// production prediction: D-072 measured 86.7% of production replies as cache MISSES.
const cacheMode = (arg('cache') ?? '1h') as 'off' | '5m' | '1h';

if (process.env['ANTHROPIC_API_KEY'] === undefined) {
  process.stderr.write('ANTHROPIC_API_KEY is not set. Nothing was called and nothing was spent.\n');
  process.exit(2);
}

// `--kb` and `--set` point the SAME pipeline at a candidate knowledge base or a focused test
// set — e.g. a tenant row proposed for the founder's approval, measured before anybody
// writes it to the live project. The defaults are the committed snapshot and corpus.
const kb = JSON.parse(readFileSync(arg('kb') ?? 'scripts/bakeoff/live-kb.json', 'utf8')) as TenantKb & {
  canned: { kind: string; body: string }[];
};
const set = JSON.parse(readFileSync(arg('set') ?? 'scripts/bakeoff/testset.json', 'utf8'));

// `--gate` carries the tenant's refusal rules and deterministic replies as dumped rows,
// shaped by the SAME functions `reception/load.ts` uses. Without it the harness runs with
// no gate at all, which measures a bot production never runs.
const gateRows = arg('gate') === undefined ? null : JSON.parse(readFileSync(arg('gate') as string, 'utf8')) as {
  disclosure?: unknown[]; outOfScope?: unknown[]; deterministic?: unknown[];
  /** `forbidden_phrasings` rows (tenant and platform), `{ gate, stems }`, keyed by gate as `load.ts` keys them. */
  phrasings?: { gate: string; stems: string[] }[];
  /** `service_aliases` joined to the service's name, `{ name, alias }`, as `load.ts` shapes them. */
  aliases?: { name: string; alias: string }[];
  /** `spellings` rows that are settled or confirmed, `{ latin, cyrillic }` (D-120). */
  spellings?: { latin: string; cyrillic: string }[];
};
const PHRASINGS: Record<string, string[][]> = {};
for (const p of gateRows?.phrasings ?? []) (PHRASINGS[p.gate] ??= []).push(p.stems);
const GATE_RULES = gateRows === null ? [] : [...toRules(gateRows.disclosure ?? [], false), ...toRules(gateRows.outOfScope ?? [], false)];
const DETERMINISTIC = gateRows === null ? [] : toDeterministic(gateRows.deterministic ?? []);

// The signed platform blocks, in the order and layers `loadPromptSections` gives them.
// Read from disk because `02_style` was proven byte-identical to its `prompt_blocks` row,
// and `check-mn-review.mjs` fails the build if any file drifts from its signed hash.
const PLATFORM: { key: string; ordinal: number }[] = [
  { key: '00_gate_preamble', ordinal: 0 }, { key: '01_data_marker', ordinal: 1 },
  { key: '02_style', ordinal: 2 },
  ...['sh0_channel', 'sh1_refusal_topics', 'sh2_price', 'sh3_booking', 'sh4_staff_schedule',
    'sh5_health', 'sh6_concessions', 'sh7_abuse_offtopic', 'sh8_not_in_kb',
    'sh9_instruction_disclosure'].map((key, i) => ({ key, ordinal: 100 + i })),
  // Signed 2026-09-21. `gateOrder` gives it 111 from the filename, after Ш9.
  { key: 'sh11_completeness', ordinal: 111 },
];
const APPROVED = '2026-09-04T00:00:00Z';

/**
 * `--drafts` swaps in the UNSIGNED revisions from `prompt/drafts/`, so the founder can be
 * shown what they actually produce before he signs anything.
 *
 * This is a measurement harness, not the reply path: nothing here can publish, and
 * `check-mn-review.mjs` still fails the build if a file in `prompt/platform/` drifts from
 * its signed hash. The drafts remain loaded by nothing in production.
 *
 * A draft file carries an explanatory header for the reviewer and then `--- THE BLOCK ---`.
 * Only what follows that marker is prompt. A file with no marker is used whole, which is
 * how the older drafts were written.
 */
const USE_DRAFTS = process.argv.includes('--drafts');
const DRAFT_SWAPS: Record<string, string> = {
  // 00_gate_preamble was signed on 2026-09-21 20:5x, after its no-labels revision measured
  // 0 gate-label leaks in 96 replies against the seeded block's 6. It is read from
  // prompt/platform/ like any other block now, so it is NOT swapped here — leaving the
  // entry would have pointed --drafts at a file that no longer exists and thrown.
  'sh2_price': 'sh2_price_precedence',
  'sh11_completeness': 'sh11_completeness_names',
  'sh3_booking': 'sh3_booking_deposit',
};
/** Blocks that exist ONLY as drafts, appended after the numbered gate. */
const DRAFT_EXTRA: { key: string; file: string; ordinal: number }[] = [];
const MARKER = '--- THE BLOCK ---';
function blockBody(path: string): string {
  const raw = readFileSync(path, 'utf8');
  const i = raw.indexOf(MARKER);
  return i === -1 ? raw : raw.slice(i + MARKER.length).replace(/^\r?\n/, '');
}
function platformBody(key: string): string {
  if (USE_DRAFTS && key in DRAFT_SWAPS) {
    const f = `prompt/drafts/${DRAFT_SWAPS[key]}.mn.txt`;
    if (existsSync(f)) return blockBody(f);
    throw new Error(`--drafts names ${f}, which does not exist`);
  }
  return readFileSync(`prompt/platform/${key}.mn.txt`, 'utf8');
}
const platformSections: PromptSection[] = [
  ...PLATFORM.map((b) => ({
    layer: 'L0' as const, key: b.key, ordinal: b.ordinal,
    body: platformBody(b.key), reviewedAt: APPROVED, origin: 'platform' as const,
  })),
  ...(USE_DRAFTS ? DRAFT_EXTRA.map((b) => ({
    layer: 'L0' as const, key: b.key, ordinal: b.ordinal,
    body: blockBody(`prompt/drafts/${b.file}.mn.txt`), reviewedAt: APPROVED, origin: 'platform' as const,
  })) : []),
];
if (USE_DRAFTS) {
  process.stderr.write(`--drafts: swapped ${Object.keys(DRAFT_SWAPS).join(', ')}; `
    + `added ${DRAFT_EXTRA.map((d) => d.key).join(', ')}\n`);
}

const compiled = renderStablePrefix([...platformSections, ...renderTenantSections(kb, APPROVED)]);
if (!compiled.ok) {
  process.stderr.write(`the prefix did not compile: ${JSON.stringify(compiled.refusal)}\n`);
  process.exit(3);
}
const promptStable = compiled.rendered.promptStable;
const allowedNumbers = compiled.rendered.allowedNumbers;
process.stdout.write(
  `dala: prefix ${promptStable.length} chars · ${allowedNumbers.length} allowed numeral(s)\n`
  + `      prices in prefix: ${/135,000/.test(promptStable) ? 'YES' : 'NO'}\n`);

const cannedHash = cannedHashOf(kb.canned);

/** A stub `ReceptionDeps`: everything downstream of the decision, and nothing upstream. */
function deps(record: { body?: string; answeredBy?: string; flags: string[]; usage?: unknown }): ReceptionDeps {
  return {
    // The REAL model call, same function the worker uses.
    callModel: (req) => callReception(req, process.env['ANTHROPIC_API_KEY'] as string),
    draft: async ({ body, answeredBy }) => { record.body = body; record.answeredBy = answeredBy; return { ok: true, id: 'test' }; },
    markCalled: async () => true,
    settle: async (usage) => { record.usage = usage; return { ok: true }; },
    release: async () => {},
    // The CODE alone is not enough, and keeping only it was this harness's own instance
    // of D-070: a refused reply and a clean one differ only in text the harness threw
    // away, so `outbound_gate_label` appeared twice in a run with nothing to diagnose it
    // from. `quality_flags` in production has carried `attempted` all along — this is the
    // measurement rig being worse than the thing it measures.
    flag: async (f) => {
      record.flags.push(f.code);
      record.flagDetail.push({ code: f.code, detail: f.detail, attempted: f.attempted });
    },
    observe: async () => {},
  };
}

async function ask(text: string, attachments: readonly string[], history: { role: 'user' | 'assistant'; content: string }[]) {
  const record: {
    body?: string; answeredBy?: string; flags: string[]; usage?: unknown;
    flagDetail: { code: string; detail?: string; attempted?: string }[];
  } = { flags: [], flagDetail: [] };
  // `--now 2026-09-24T14:00:00+08:00` answers as though the customer wrote then. The first
  // comparison ran at 01:10 Ulaanbaatar and c05 («unuudur tsag bnu») was — correctly — told
  // the salon was closed; the founder read it as a timezone bug. Production passes the real
  // request instant and the tenant's own timezone to the same `renderVolatile`.
  const now = NOW === undefined ? new Date() : new Date(NOW);
  const started = Date.now();
  try {
    const out = await handleReception(deps(record), {
      customerMessage: text, customerAttachments: attachments, customerSentPhoto: attachments.includes('image'), history,
      eventAt: now, now, promptStable,
      promptVolatile: renderVolatile({ now, timezone: TZ, surface: 'direct_message', hours: kb.hours, closures: [] }),
      modelId: MODEL, cacheMode, timeoutMs: 25_000,
      rules: GATE_RULES, deterministic: DETERMINISTIC,
      historyState: { known: true, empty: history.length === 0 },
      canned: kb.canned.map((c) => ({ kind: c.kind, body: c.body, reviewedAt: APPROVED })),
      tenantGuard: {
        primaryScript: 'Cyrl',
        // Every link the tenant declared, exactly as `load.ts` gathers them: the booking
        // URL plus any link-shaped contact point. Omitting these is what made `urlsNotAllowed`
        // refuse the salon's own Maps link in D-071.
        allowedUrls: [
          ...(kb.bookingUrl === null ? [] : [kb.bookingUrl]),
          ...kb.contacts.filter((c) => /^https?:\/\//.test(c.value)).map((c) => c.value),
        ],
        allowedNumbers,
        kbHasPromotion: false,
        concessionStems: [],
        forbiddenStemSeqs: PHRASINGS,
        // THE GATE only, not the whole prefix (D-084): the platform blocks are the prompt a
        // disclosure would leak; the tenant's own knowledge base is the material the bot
        // exists to relay.
        promptCorpus: compiled.rendered.promptGate ?? promptStable,
        cannedResponses: kb.canned.map((c) => c.body),
        scriptShareExclusions: [...kb.services.map((s) => s.name), ...(kb.bookingUrl === null ? [] : [kb.bookingUrl])],
        maxReplyChars: MAX_REPLY_CHARS,
      } as never,
      cannedLabel: SECTION_LABELS.canned, cannedHash,
      serviceNames: servicesFromPrefix(promptStable, SECTION_LABELS.priceList),
      depositRows: sectionRows(promptStable, SECTION_LABELS.deposits),
      faqAnswers: faqAnswersFromPrefix(promptStable, SECTION_LABELS.faqs),
      serviceAliases: gateRows?.aliases ?? [],
      spellings: gateRows?.spellings ?? [],
    } as never);
    return { ok: true, reply: record.body ?? null, answeredBy: record.answeredBy ?? null,
      flags: record.flags, flagDetail: record.flagDetail, kind: (out as { kind: string }).kind, ms: Date.now() - started,
      // Carried out so real spend is computed from the API's own numbers rather than
      // estimated — the founder's ceiling is a real ceiling and an estimate is not a count.
      usage: record.usage ?? null };
  } catch (e) {
    return { ok: false, reply: null, error: e instanceof Error ? e.message : String(e), flags: record.flags, ms: Date.now() - started };
  }
}

const out: Record<string, unknown> = { ranAt: new Date().toISOString(), model: MODEL, tag,
  prefixChars: promptStable.length, allowedNumbers, singles: {}, conversations: {} };
const want = (id: string) => only === null || only.includes(id);

for (const c of set.cases) {
  if (!want(c.id)) continue;
  const r = await ask(c.text, [], []);
  (out['singles'] as Record<string, unknown>)[c.id] = { text: c.text, ...r };
  process.stdout.write(`  ${c.id}  ${String(r.ms).padStart(6)}ms  ${r.ok ? `${r.answeredBy}/${(r.reply ?? '').length}ch` : `ERROR ${r.error}`}${r.flags.length ? `  [${r.flags.join(',')}]` : ''}\n`);
}
for (const c of set.attachmentCases) {
  if (!want(c.id)) continue;
  const r = await ask(c.text, c.attachments ?? [], []);
  (out['singles'] as Record<string, unknown>)[c.id] = { text: c.text, attachments: c.attachments, ...r };
  process.stdout.write(`  ${c.id}  ${String(r.ms).padStart(6)}ms  ${r.ok ? `${r.answeredBy}/${(r.reply ?? '').length}ch` : `ERROR ${r.error}`}\n`);
}
for (const conv of set.conversations) {
  if (only !== null && !want(conv.id)) continue;
  const history: { role: 'user' | 'assistant'; content: string }[] = [];
  const turns = [];
  for (const t of conv.turns) {
    const r = await ask(t, [], [...history]);
    turns.push({ text: t, ...r });
    history.push({ role: 'user', content: t });
    // The reply goes back into history — which is the whole point of D-111, and running
    // the thread without it would reproduce the bug inside the harness measuring it.
    if (r.ok && r.reply !== null) history.push({ role: 'assistant', content: r.reply });
    process.stdout.write(`  ${conv.id}  ${String(r.ms).padStart(6)}ms  ${r.ok ? `${r.answeredBy}/${(r.reply ?? '').length}ch` : `ERROR ${r.error}`}\n`);
  }
  (out['conversations'] as Record<string, unknown>)[conv.id] = { turns };
}

mkdirSync('scripts/bakeoff/runs', { recursive: true });
const path = `scripts/bakeoff/runs/dala-${tag}.json`;
writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
process.stdout.write(`\nwrote ${path}\n`);
void existsSync;
