import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cannedHashOf, compileAndPublish, compileStablePrefix, loadPromptSections } from './sections.ts';
import { renderStablePrefix, type PromptSection } from './render.ts';

const TENANT = '11111111-0000-4000-8000-000000000001';

type Row = Record<string, unknown>;

function block(over: Row = {}): Row {
  return {
    scope: 'platform', tenant_id: null, block_key: 'sh0_channel', ordinal: 100,
    layer: 'L0', body: 'Ш0. СУВАГ.', reviewed_at: '2026-09-04T00:00:00Z', ...over,
  };
}

/**
 * `prompt_blocks` answers `reply`; every tenant-KB table answers from `kb` (empty by
 * default) so a test about blocks does not have to describe a knowledge base.
 */
function stubDb(reply: { data?: unknown; error?: unknown }, kb: Record<string, { data?: unknown; error?: unknown }> = {}) {
  const calls: { table: string; cols: string; filter: string; ordered: string[] }[] = [];
  const from = (table: string) => {
    const rec = { table, cols: '', filter: '', ordered: [] as string[] };
    calls.push(rec);
    const chain: Record<string, unknown> = {};
    chain['select'] = (cols: string) => ((rec.cols = cols), chain);
    chain['or'] = (f: string) => ((rec.filter = f), chain);
    chain['eq'] = () => chain;
    chain['order'] = (col: string) => (rec.ordered.push(col), chain);
    const answer = () => {
      if (table === 'prompt_blocks') return reply;
      if (table === 'tenants') return kb['tenants'] ?? { data: { currency_symbol: '₮', currency_symbol_before: false }, error: null };
      if (table === 'tenant_booking') return kb[table] ?? { data: null, error: null };
      return kb[table] ?? { data: [], error: null };
    };
    chain['maybeSingle'] = async () => answer();
    chain['then'] = (res: (v: unknown) => unknown) => res(answer());
    return chain;
  };
  return { calls, db: { from } as never };
}

const APPROVED = '2026-09-04T00:00:00Z';

// ---------------------------------------------------------------------------
// What reaches the prompt, and what must not
// ---------------------------------------------------------------------------

test('DONE-TEST: rows with a null layer never become prompt sections', async () => {
  // `prompt_blocks` holds three families. Nine of the twenty-one rows are NOT prompt
  // sections: the eight data-deletion status strings and the comment reply template.
  // If one leaked in, a status-page sentence would be pasted into every tenant's system
  // prompt — and it would render perfectly, so nothing would say so.
  const { db } = stubDb({
    data: [
      block(),
      block({ block_key: 'data_deletion_title', layer: null, ordinal: 0, body: 'Мэдээлэл устгах хүсэлт' }),
      block({ block_key: 'comment_public_reply', layer: null, ordinal: 0, body: 'Сайн байна уу!' }),
    ],
    error: null,
  });
  const out = await loadPromptSections(db, { tenantId: TENANT, vertical: 'salon' });
  assert.equal(out.ok, true);
  assert.deepEqual(out.ok === true ? out.sections.map((s) => s.key) : [], ['sh0_channel']);
});

test('DONE-TEST: an unreviewed block is LOADED, so the renderer refuses instead of dropping it', async () => {
  // The tempting query is `where reviewed_at is not null`. Filtering here would compile a
  // prompt one Ш block shorter, successfully, with that boundary simply absent. Loading it
  // makes `renderStablePrefix` refuse and name it.
  const { db } = stubDb({
    data: [block(), block({ block_key: 'sh5_health', ordinal: 105, reviewed_at: null })],
    error: null,
  });
  const loaded = await loadPromptSections(db, { tenantId: TENANT, vertical: 'salon' });
  assert.equal(loaded.ok && loaded.sections.length, 2, 'both loaded — the unreviewed one is not dropped');

  const compiled = await compileStablePrefix(db, { tenantId: TENANT, approvedAt: APPROVED });
  assert.equal(compiled.ok, false);
  assert.equal(compiled.ok === false && compiled.code, 'refused');
  const refusal = compiled.ok === false && compiled.code === 'refused' ? compiled.refusal : null;
  assert.equal(refusal?.code, 'canned_response_unreviewed');
  assert.deepEqual(refusal?.sections, ['sh5_health']);
});

test('DONE-TEST: a database with no platform blocks refuses rather than compiling a gateless prompt', async () => {
  // The dangerous case, and the reason `no_gate` exists. Tenant rows alone render a
  // perfectly valid prompt carrying the price list and staff roster with none of Ш0–Ш9 —
  // no public-channel rule, no price discipline, no health boundary. `empty_prefix` does
  // not catch it because the prefix is not empty.
  const { db } = stubDb({
    data: [block({ scope: 'tenant', tenant_id: TENANT, block_key: 'price_list', layer: 'L3', ordinal: 0 })],
    error: null,
  });
  const out = await compileStablePrefix(db, { tenantId: TENANT, approvedAt: APPROVED });
  assert.equal(out.ok, false);
  assert.equal(out.ok === false && out.code, 'no_gate');
});

test('the read is scoped to this tenant and to platform rows, never across tenants', async () => {
  // These queries run under service_role, which holds BYPASSRLS — there is no policy
  // adding the tenant filter, so its absence would pull every tenant's blocks into one
  // prompt.
  const { db, calls } = stubDb({ data: [block()], error: null });
  await loadPromptSections(db, { tenantId: TENANT, vertical: 'salon' });
  assert.equal(calls[0]?.table, 'prompt_blocks');
  assert.ok(calls[0]?.filter.includes(`tenant_id.eq.${TENANT}`));
  assert.ok(calls[0]?.filter.includes('scope.eq.platform'));
  assert.ok(calls[0]?.filter.includes('tenant_id.is.null'));
  assert.equal(calls.length, 1, 'one query — two could straddle a publish and mix configurations');
});

test('an unreadable table is unavailable, never an empty prompt', async () => {
  const { db } = stubDb({ error: { message: 'reset' } });
  const out = await compileStablePrefix(db, { tenantId: TENANT, approvedAt: APPROVED });
  assert.equal(out.ok === false && out.code, 'unavailable');
});

test('scope becomes origin, so a tenant row can never claim a platform layer unnoticed', async () => {
  const { db } = stubDb({
    data: [block(), block({ scope: 'tenant', tenant_id: TENANT, block_key: 'sneaky', layer: 'L0', ordinal: 1 })],
    error: null,
  });
  const out = await compileStablePrefix(db, { tenantId: TENANT, approvedAt: APPROVED });
  assert.equal(out.ok, false);
  const refusal = out.ok === false && out.code === 'refused' ? out.refusal : null;
  assert.equal(refusal?.code, 'layer_violation');
  assert.deepEqual(refusal?.sections, ['sneaky(tenant/L0)']);
});

test('a malformed row is skipped rather than sorting as NaN', async () => {
  const { db } = stubDb({
    data: [block(), block({ block_key: '', ordinal: 5 }), block({ block_key: 'x', ordinal: 'nonsense', layer: 'L0' })],
    error: null,
  });
  const out = await loadPromptSections(db, { tenantId: TENANT, vertical: 'salon' });
  assert.deepEqual(out.ok === true ? out.sections.map((s) => s.key) : [], ['sh0_channel', 'x']);
  assert.equal(out.ok === true ? out.sections[1]?.ordinal : null, 0, 'NaN would compare false against everything');
});

// ---------------------------------------------------------------------------
// The real signed blocks, compiled
// ---------------------------------------------------------------------------

test('DONE-TEST: the twelve signed gate blocks compile into one prefix, in wire order', async () => {
  // The whole point of this module, over the real text. `renderStablePrefix` had never
  // been given real sections; this is that call, with the bytes a native speaker signed.
  const { readSignedBlocks } = await import('../../../scripts/prompt/generate-seed.ts');
  const sections: PromptSection[] = readSignedBlocks()
    .filter((b) => b.layer !== null)
    .map((b) => ({
      layer: b.layer as 'L0',
      key: b.blockKey,
      ordinal: b.ordinal,
      body: b.body,
      reviewedAt: b.reviewedAt,
      origin: 'platform' as const,
    }));
  assert.equal(sections.length, 12);

  const out = renderStablePrefix(sections);
  assert.equal(out.ok, true);
  if (!out.ok) return;

  assert.deepEqual(out.rendered.order, [
    '00_gate_preamble', '01_data_marker',
    'sh0_channel', 'sh1_refusal_topics', 'sh2_price', 'sh3_booking', 'sh4_staff_schedule',
    'sh5_health', 'sh6_concessions', 'sh7_abuse_offtopic', 'sh8_not_in_kb',
    'sh9_instruction_disclosure',
  ]);

  // The gate preamble must come first: it is the instruction to evaluate every check,
  // and a model that reads Ш5 before being told to read them all may stop at the first.
  assert.ok(out.rendered.promptStable.startsWith('=== ХАРИУЛАХЫН ӨМНӨХ'));
  assert.equal(out.rendered.contentHash.length, 64);
  assert.ok(out.rendered.promptChars > 3000, `only ${out.rendered.promptChars} characters`);

  // Nothing from the other two families reached it.
  assert.ok(!out.rendered.promptStable.includes('Баталгааны код'), 'a status-page string is in the prompt');
  assert.ok(!out.rendered.promptStable.includes('Бидэн рүү мессеж бичээрэй'), 'the comment template is in the prompt');
});

test('DONE-TEST: compiling the gate does NOT allow-list the fabricated prices it forbids', async () => {
  // Found by compiling the real blocks and reading the output. The gate's numerals are its
  // COUNTER-EXAMPLES — «33,000₮» is Ш1's wrong answer to a children's price question,
  // «20,000₮» is Ш2's invented price, «15:00» is Ш3's fake booking confirmation. Deriving
  // `allowed_numbers` from the whole prefix handed the outbound guard exactly the
  // fabrications the gate exists to prevent, so Ш2 would forbid «20,000₮ орчим» and the
  // guard would then wave it through: two layers, perfectly correlated, both saying yes.
  const { readSignedBlocks } = await import('../../../scripts/prompt/generate-seed.ts');
  const sections: PromptSection[] = readSignedBlocks()
    .filter((b) => b.layer !== null)
    .map((b) => ({
      layer: b.layer as 'L0', key: b.blockKey, ordinal: b.ordinal,
      body: b.body, reviewedAt: b.reviewedAt, origin: 'platform' as const,
    }));
  const out = renderStablePrefix(sections);
  assert.equal(out.ok, true);
  if (!out.ok) return;

  assert.deepEqual(out.rendered.allowedNumbers, [], 'a gate-only prompt licenses no numeral at all');
  // And the counter-examples are still IN the prompt, where the model must read them.
  assert.ok(out.rendered.promptStable.includes('33,000'));
  assert.ok(out.rendered.promptStable.includes('20,000'));
});

// ---------------------------------------------------------------------------
// D-020 — provenance, on the way into the prompt
// ---------------------------------------------------------------------------

const CONFIRMED_FAQ = { question: 'Зогсоол байдаг уу?', answer: 'Барилгын ард байрлана.', provenance: 'tenant_confirmed' };
const SEEDED_FAQ = { question: 'Хүргэлт хийдэг үү?', answer: 'Тийм, 15,000₮.', provenance: 'seeded' };

test('DONE-TEST: a seeded FAQ never reaches the prompt, and its PRICE never reaches allowed_numbers', async () => {
  // This is where D-020 and D-024 meet, and it is the whole reason the facts half excludes
  // rather than counts. `allowed_numbers` is derived from the tenant sections, so a
  // guessed price in a FAQ does not merely get stated — it ALLOW-LISTS ITSELF past the
  // outbound guard. The one control that exists to catch an invented number would be
  // holding the invented number in its own allow-list.
  const { db } = stubDb(
    { data: [block({ block_key: 'gate', body: 'Ш0. дүрэм' })], error: null },
    { faqs: { data: [CONFIRMED_FAQ, SEEDED_FAQ], error: null } },
  );
  const out = await compileStablePrefix(db, { tenantId: TENANT, approvedAt: APPROVED });
  assert.equal(out.ok, true);
  if (!out.ok) return;

  assert.ok(out.rendered.promptStable.includes('Зогсоол байдаг уу?'), 'the confirmed FAQ is rendered');
  assert.equal(out.rendered.promptStable.includes('Хүргэлт хийдэг үү?'), false, 'the seeded FAQ is not');
  assert.equal(out.rendered.allowedNumbers.includes('15,000'), false, 'and its price is not licensed');
  assert.deepEqual(out.unconfirmed.faqsExcluded, ['Хүргэлт хийдэг үү?'], 'and the exclusion is NAMED, not silent');
});

test('DONE-TEST: a FAQ with no provenance column at all is excluded, not trusted', async () => {
  // The realistic shape of this failure is a database that predates 0011, or a seed script
  // written before it. Neither says `seeded`; both say nothing.
  const { db } = stubDb(
    { data: [block({ block_key: 'gate', body: 'Ш0. дүрэм' })], error: null },
    { faqs: { data: [{ question: 'Хэдэн цагт нээдэг вэ?', answer: '10:00' }], error: null } },
  );
  const out = await compileStablePrefix(db, { tenantId: TENANT, approvedAt: APPROVED });
  assert.equal(out.ok && out.rendered.promptStable.includes('Хэдэн цагт нээдэг вэ?'), false);
  assert.deepEqual(out.ok && out.unconfirmed.faqsExcluded, ['Хэдэн цагт нээдэг вэ?']);
});

test('DONE-TEST: a seeded REFUSAL topic is kept in the prompt — and counted', async () => {
  // The opposite call from the FAQ above, on purpose. Dropping an unconfirmed refusal
  // topic removes it from «ХОРИОТОЙ СЭДВҮҮД», so Ш1 stops asking about it and the topic
  // becomes discussable — a silently disarmed refusal, which is the failure `matchRules`
  // refuses to commit. Over-refusing costs a handoff line; under-refusing costs the thing
  // the rule existed to prevent.
  const { db } = stubDb(
    { data: [block({ block_key: 'gate', body: 'Ш0. дүрэм' })], error: null },
    {
      disclosure_rules: { data: [{ topic_key: 'children_services', provenance: 'seeded' }], error: null },
      out_of_scope_topics: { data: [{ topic_key: 'medical_advice', provenance: 'tenant_confirmed' }], error: null },
    },
  );
  const out = await compileStablePrefix(db, { tenantId: TENANT, approvedAt: APPROVED });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.ok(out.rendered.promptStable.includes('children_services'), 'the seeded refusal still guards');
  assert.ok(out.rendered.promptStable.includes('medical_advice'));
  assert.deepEqual(out.unconfirmed.refusalTopicsUnconfirmed, ['children_services']);
});

test('DONE-TEST: the loader reads decision_question and orders the merged list by key', () => {
  // Two tables, read separately, merged into one list. PostgREST promises nothing about
  // their order relative to each other, so without an explicit sort the rendered prefix —
  // and therefore `content_hash`, and therefore the prompt-cache key — differs between two
  // compiles of identical rows. The symptom is not an error: it is a cache that never hits.
  return (async () => {
    const { calls, db } = stubDb(
      { data: [block({ block_key: 'gate', body: 'Ш0. дүрэм' })], error: null },
      {
        disclosure_rules: { data: [{ topic_key: 'zebra', decision_question: 'З?', provenance: 'tenant_confirmed' }], error: null },
        out_of_scope_topics: { data: [{ topic_key: 'alpha', decision_question: 'А?', provenance: 'tenant_confirmed' }], error: null },
      },
    );
    const out = await compileStablePrefix(db, { tenantId: TENANT, approvedAt: APPROVED });
    assert.equal(out.ok, true);
    if (!out.ok) return;

    for (const table of ['disclosure_rules', 'out_of_scope_topics']) {
      assert.ok(calls.find((c) => c.table === table)?.cols.includes('decision_question'), `${table} must select it`);
    }
    const body = out.rendered.promptStable;
    assert.ok(body.includes('- alpha: А?'), body);
    assert.ok(body.includes('- zebra: З?'), body);
    assert.ok(body.indexOf('- alpha') < body.indexOf('- zebra'), 'sorted by key, across both tables');
  })();
});

test('a fully confirmed tenant reports nothing unconfirmed', async () => {
  const { db } = stubDb(
    { data: [block({ block_key: 'gate', body: 'Ш0. дүрэм' })], error: null },
    {
      faqs: { data: [CONFIRMED_FAQ], error: null },
      disclosure_rules: { data: [{ topic_key: 'children_services', provenance: 'tenant_confirmed' }], error: null },
    },
  );
  const out = await compileStablePrefix(db, { tenantId: TENANT, approvedAt: APPROVED });
  assert.deepEqual(out.ok && out.unconfirmed, { faqsExcluded: [], refusalTopicsUnconfirmed: [] });
});

test('the loader ASKS for provenance — a select that forgets it excludes everything', async () => {
  // The column is only honoured if it is fetched. PostgREST returns exactly the columns
  // named, so a dropped `provenance` from the select list would make every row read as
  // unconfirmed and empty the knowledge base — loudly, but only if something checks that
  // the query asked.
  const { calls, db } = stubDb({ data: [block()], error: null });
  await compileStablePrefix(db, { tenantId: TENANT, approvedAt: APPROVED });
  for (const table of ['faqs', 'disclosure_rules', 'out_of_scope_topics']) {
    const call = calls.find((c) => c.table === table);
    assert.ok(call?.cols.includes('provenance'), `${table} must select provenance`);
  }
});

// ---------------------------------------------------------------------------
// Ordering — the prefix must not depend on the database's collation
// ---------------------------------------------------------------------------

/** Rows whose collation order differs between C.UTF-8 and en_US.UTF-8. Measured, not guessed. */
const SERVICES = [
  { id: 's1', name: 'Үс засалт' },
  { id: 's2', name: 'үс будалт' },
  { id: 's3', name: 'Чёлк тайралт' },
  { id: 's4', name: 'Челк тайралт' },
];
/**
 * Ordinal order and alphabetical order DISAGREE here, deliberately. «Ямар» (Я, U+042F)
 * is alphabetically last and carries ordinal 0; «Ажлын» (А, U+0410) is alphabetically
 * first and carries ordinal 1. A fixture where the two agree cannot tell a correct sort
 * from one that silently dropped the tenant's own priority — the first version of this
 * fixture had exactly that hole and a mutation walked straight through it.
 */
const FAQS = [
  { question: 'Ажлын цаг?', answer: '10:00-20:00', ordinal: 1, provenance: 'tenant_confirmed' },
  { question: 'Ямар үйлчилгээ байдаг вэ?', answer: 'Үс засалт, будалт.', ordinal: 0, provenance: 'tenant_confirmed' },
];
const CONTACTS = [{ kind: 'phone', value: '7741-7777' }, { kind: 'address', value: 'СБД' }];
/** A service renders nothing without a priced variant, so each one needs one. */
const VARIANTS = SERVICES.map((sv, i) => ({
  service_id: sv.id, variant_key: '', price_kind: 'exact',
  price_min: `${(i + 3) * 10000}.00`, price_max: null, refusal_topic: null,
}));

async function compileWith(order: 'given' | 'reversed') {
  const flip = <T,>(a: T[]): T[] => (order === 'reversed' ? [...a].reverse() : a);
  const { db } = stubDb(
    { data: [block({ block_key: 'gate', body: 'Ш0. дүрэм' })], error: null },
    {
      services: { data: flip(SERVICES), error: null },
      service_variants: { data: flip(VARIANTS), error: null },
      faqs: { data: flip(FAQS), error: null },
      contact_points: { data: flip(CONTACTS), error: null },
    },
  );
  return compileStablePrefix(db, { tenantId: TENANT, approvedAt: APPROVED });
}

test('DONE-TEST: the same rows compile to the same prefix whatever order the database returns them in', async () => {
  // This is the whole point. SQL `order by` sorts under the SERVER's collation, and the
  // two environments disagree: CI is C.UTF-8, the Supabase project is en_US.UTF-8, and on
  // these exact strings they produce completely different orders (measured 2026-09-05).
  //
  // That order becomes the line order of L2/L3, which becomes the prefix, which becomes
  // `content_hash` — the prompt-cache key. If it tracked the database, the prefix CI
  // compiled would not be the prefix production compiled from identical rows, and a glibc
  // collation bump beneath the database would cold-miss every warm entry with nothing
  // going red anywhere.
  const a = await compileWith('given');
  const b = await compileWith('reversed');
  assert.equal(a.ok && b.ok, true);
  assert.equal(a.ok && a.rendered.contentHash, b.ok && b.rendered.contentHash,
    'a reversed read must not change the compiled prefix');
  assert.equal(a.ok && a.rendered.promptStable, b.ok && b.rendered.promptStable);
});

test('and the order it settles on is code point, not the locale order', async () => {
  const r = await compileWith('given');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const body = r.rendered.promptStable;
  // Code point: Челк < Чёлк < ҮС... < Үс... < үс...  (uppercase before lowercase)
  assert.ok(body.indexOf('Челк тайралт') < body.indexOf('Чёлк тайралт'), 'Челк before Чёлк');
  assert.ok(body.indexOf('Чёлк тайралт') < body.indexOf('Үс засалт'), 'Ч before Ү');
  assert.ok(body.indexOf('Үс засалт') < body.indexOf('үс будалт'), 'uppercase Ү before lowercase ү');
});

test('ordinal outranks text, because it is the tenant\'s own priority', async () => {
  // FAQs carry an explicit ordinal. Sorting them by question alone would silently discard
  // the order the tenant chose, which is a different bug from a nondeterministic one.
  const r = await compileWith('given');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const body = r.rendered.promptStable;
  assert.ok(body.indexOf('Ямар үйлчилгээ байдаг вэ?') < body.indexOf('Ажлын цаг?'),
    'ordinal 0 (Ямар) must precede ordinal 1 (Ажлын), even though Ажлын sorts first alphabetically');
});

// ---------------------------------------------------------------------------
// The whole chain: blocks → sections → prefix → snapshot
// ---------------------------------------------------------------------------

/** A db that answers each table by name, recording every write. */
function chainDb(over: Record<string, { data?: unknown; error?: unknown }> = {}) {
  const writes: { table: string; op: string; patch: Record<string, unknown>[] }[] = [];
  const answer = (table: string) => {
    if (over[table] !== undefined) return over[table];
    if (table === 'config_revisions') return { data: { status: 'draft' }, error: null };
    if (table === 'tenants') return { data: { currency_symbol: '₮', currency_symbol_before: false }, error: null };
    if (table === 'tenant_booking') return { data: null, error: null };
    return { data: [], error: null };
  };
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'neq', 'or', 'is', 'order']) chain[m] = () => chain;
    for (const m of ['insert', 'update'] as const) {
      chain[m] = (patch: Record<string, unknown> | Record<string, unknown>[]) => {
        writes.push({ table, op: m, patch: Array.isArray(patch) ? patch : [patch] });
        return chain;
      };
    }
    chain['maybeSingle'] = async () => answer(table);
    chain['then'] = (res: (v: unknown) => unknown) => res(answer(table));
    return chain;
  };
  return { writes, db: { from } as never };
}

test('DONE-TEST: the chain closes — signed blocks become a published snapshot', async () => {
  const { db, writes } = chainDb({
    prompt_blocks: {
      data: [
        block({ block_key: '00_gate_preamble', ordinal: 0, body: 'ЖАГСААЛТ' }),
        block({ block_key: 'sh0_channel', ordinal: 100, body: 'Ш0. СУВАГ.' }),
        block({ scope: 'tenant', tenant_id: TENANT, block_key: 'price_list', layer: 'L3', ordinal: 0, body: 'Угаалт 22,000₮' }),
      ],
      error: null,
    },
  });

  const out = await compileAndPublish(db, {
    tenantId: TENANT,
    revisionId: 'rev-1',
    channels: ['messenger', 'instagram'],
    now: new Date('2026-09-04T12:00:00Z'),
  });
  assert.equal(out.ok, true);
  assert.equal(out.ok && out.sectionCount, 3);

  const snapshots = writes.find((w) => w.table === 'config_snapshots');
  assert.equal(snapshots?.patch.length, 2, 'one snapshot per channel');
  // Ш0 is the channel rule and it lives INSIDE the prompt, so one compile serves both
  // surfaces. Compiling per channel would invite omitting Ш0 for DM "because it does not
  // apply", which is how a public price leak starts.
  assert.equal(snapshots?.patch[0]?.['content_hash'], snapshots?.patch[1]?.['content_hash']);
  assert.equal(snapshots?.patch[0]?.['prompt_stable'], snapshots?.patch[1]?.['prompt_stable']);
  assert.deepEqual(snapshots?.patch[0]?.['allowed_numbers'], ['22,000'], 'tenant facts only');
  assert.equal(snapshots?.patch[0]?.['prompt_volatile'], '', 'L4 is per-request and never snapshotted');

  // Insert first, point second — publish.ts's rule. The pointer move is last.
  const order = writes.map((w) => `${w.table}.${w.op}`);
  assert.equal(order[0], 'config_snapshots.insert');
  assert.equal(order[order.length - 1], 'tenants.update');
});

test('DONE-TEST: THE CANNED LINES ARE IN THE PREFIX, AND THE SNAPSHOT SAYS WHICH ONES', async () => {
  // D-058, end to end: the rows are read, rendered into `prompt_stable`, and their identity
  // recorded on the snapshot. The hash is the half that makes the move safe — without it a
  // tenant edit after publish leaves the model and the deterministic short-circuit quoting
  // two different sentences with nothing able to notice.
  const rows = [
    { kind: 'handoff', body: 'Манай ажилтан тантай холбогдоно.', locale: 'mn' },
    { kind: 'refusal_health', body: 'Эмнэлгийн зөвлөгөө өгөх боломжгүй.', locale: 'mn' },
    // Another locale's copy of the same kind. `reception/load.ts` filters these out in SQL;
    // if this side kept them the two would render different sections for ever and every
    // reply would 503 — the failure mode of a guard whose two inputs are gathered
    // differently, which is why the locale filter is asserted here rather than assumed.
    { kind: 'handoff', body: 'Our staff will contact you.', locale: 'en' },
  ];
  const { db, writes } = chainDb({
    prompt_blocks: { data: [block({ block_key: '00_gate_preamble', ordinal: 0, body: 'ЖАГСААЛТ' })], error: null },
    tenants: { data: { currency_symbol: '₮', currency_symbol_before: false, default_locale: 'mn' }, error: null },
    canned_responses: { data: rows, error: null },
  });

  const out = await compileAndPublish(db, {
    tenantId: TENANT, revisionId: 'rev-1', channels: ['messenger'],
    now: new Date('2026-09-04T12:00:00Z'),
  });
  assert.equal(out.ok, true);

  const snap = writes.find((w) => w.table === 'config_snapshots')?.patch[0];
  const prefix = String(snap?.['prompt_stable']);
  assert.equal(prefix.includes('=== БЭЛЭН ХАРИУЛТ ==='), true, 'the section is not in the cached prefix');
  assert.equal(prefix.includes('"handoff": Манай ажилтан тантай холбогдоно.'), true);
  assert.equal(prefix.includes('Our staff will contact you.'), false, 'another locale leaked into the prefix');

  // The recorded hash is over the tenant's own locale rows only, and it is what a request
  // recomputes. Comparing against the function rather than a literal keeps this a statement
  // about agreement rather than about a particular digest.
  assert.equal(snap?.['canned_hash'], cannedHashOf([
    { kind: 'handoff', body: 'Манай ажилтан тантай холбогдоно.' },
    { kind: 'refusal_health', body: 'Эмнэлгийн зөвлөгөө өгөх боломжгүй.' },
  ]));
});

test('a tenant with no canned rows publishes a null hash, and agrees with itself', async () => {
  // The empty case is the one that would 503 every reply if the hash were taken over the
  // section as it landed: `section()` drops an empty section, so the prefix would say ''
  // and the request would say sha256('=== БЭЛЭН ХАРИУЛТ ===\n').
  const { db, writes } = chainDb({
    prompt_blocks: { data: [block({ block_key: '00_gate_preamble', ordinal: 0, body: 'ЖАГСААЛТ' })], error: null },
  });
  await compileAndPublish(db, {
    tenantId: TENANT, revisionId: 'rev-1', channels: ['messenger'],
    now: new Date('2026-09-04T12:00:00Z'),
  });
  const snap = writes.find((w) => w.table === 'config_snapshots')?.patch[0];
  assert.equal(snap?.['canned_hash'], cannedHashOf([]));
});

test('a compile that refuses never reaches the publisher', async () => {
  // A half-published config is worse than an unpublished one, because it looks live.
  const { db, writes } = chainDb({
    prompt_blocks: { data: [block({ reviewed_at: null })], error: null },
  });
  const out = await compileAndPublish(db, {
    tenantId: TENANT, revisionId: 'rev-1', channels: ['messenger'], now: new Date(),
  });
  assert.equal(out.ok, false);
  assert.equal(out.ok === false && out.code, 'refused');
  assert.match(out.ok === false ? out.detail : '', /canned_response_unreviewed: sh0_channel/);
  assert.equal(writes.length, 0, 'nothing was written');
});

test('publishing no channels is refused before anything is compiled', async () => {
  const { db, writes } = chainDb();
  const out = await compileAndPublish(db, {
    tenantId: TENANT, revisionId: 'rev-1', channels: [], now: new Date(),
  });
  assert.equal(out.ok === false && out.code, 'no_snapshot');
  assert.equal(writes.length, 0);
});

// ---------------------------------------------------------------------------
// 0018 — a platform block written for one vertical
// ---------------------------------------------------------------------------

test('DONE-TEST: A PER-VERTICAL BLOCK REACHES ITS OWN VERTICAL AND NOBODY ELSE', async () => {
  // The gate blocks are shared and five of them are written in salon language, which is
  // why tenant #0 — `vertical: software` — greeted a customer on behalf of a beauty salon
  // (D-033). The examples stay concrete, because D-011's finding is that naming the
  // forbidden wrong answer is what works; they stop being shared.
  const rows = [
    block(),
    block({ block_key: 'sh8_examples', ordinal: 108, vertical: 'salon', body: 'Ш8 жишээ: салон.' }),
    block({ block_key: 'sh8_examples', ordinal: 108, vertical: 'software', body: 'Ш8 жишээ: софтвэр.' }),
  ];
  const keysFor = async (vertical: string) => {
    const { db } = stubDb({ data: rows, error: null });
    const out = await loadPromptSections(db, { tenantId: TENANT, vertical });
    return out.ok ? out.sections.map((x) => x.body) : [];
  };
  assert.deepEqual(await keysFor('salon'), ['Ш0. СУВАГ.', 'Ш8 жишээ: салон.']);
  assert.deepEqual(await keysFor('software'), ['Ш0. СУВАГ.', 'Ш8 жишээ: софтвэр.']);
  // A vertical with no examples gets the shared blocks and nothing invented in their place.
  assert.deepEqual(await keysFor('garage'), ['Ш0. СУВАГ.']);
});

test('exactly one variant survives, so the renderer never sees an ordinal clash', async () => {
  // Two blocks in the same layer/origin/ordinal slot make `renderStablePrefix` refuse with
  // `ambiguous_order`. The per-vertical variants deliberately SHARE an ordinal — they are
  // the same slot — so the loader's filter is the only thing standing between a correct
  // compile and a refused one, and that is worth asserting rather than assuming.
  const rows = [
    block({ block_key: 'sh8_examples', ordinal: 108, vertical: 'salon', body: 'А.' }),
    block({ block_key: 'sh8_examples', ordinal: 108, vertical: 'software', body: 'Б.' }),
  ];
  const { db } = stubDb({ data: rows, error: null });
  const out = await loadPromptSections(db, { tenantId: TENANT, vertical: 'salon' });
  assert.equal(out.ok && out.sections.length, 1);
  const rendered = renderStablePrefix(out.ok ? out.sections : []);
  assert.equal(rendered.ok, true, 'one variant per slot must render');
});

test('an empty vertical on the row means every tenant, like null', async () => {
  // `tenants.vertical` is `text not null` with no CHECK, so '' is representable at both
  // ends. Treating it as "all" rather than as a vertical named empty-string keeps a
  // half-filled row harmless instead of making it match a tenant nobody meant.
  const { db } = stubDb({ data: [block({ vertical: '' })], error: null });
  const out = await loadPromptSections(db, { tenantId: TENANT, vertical: 'software' });
  assert.equal(out.ok && out.sections.length, 1);
});

test('an unreadable tenant refuses the compile rather than compiling the generic prompt', async () => {
  // Falling back to "no vertical" would silently give a tenant WITH examples the shared
  // blocks — a quieter version of exactly the bug this column exists to fix.
  const { db } = stubDb({ data: [block()], error: null }, { tenants: { data: null, error: { message: 'connection reset' } } });
  const out = await compileStablePrefix(db, { tenantId: TENANT, approvedAt: APPROVED });
  assert.equal(out.ok, false);
  assert.equal(out.ok === false && out.code, 'unavailable');
});

test('DONE-TEST: the vertical variant WINS over the generic row for the same key', () => {
  // Taking both would put two sections in one layer/origin/ordinal slot, and
  // `renderStablePrefix` refuses the whole compile as `ambiguous_order` — so "keep them
  // all" is not a conservative choice here, it is an outage for that tenant.
  const rows = [
    block({ block_key: 'sh8_examples', ordinal: 108, body: 'Ерөнхий.' }),
    block({ block_key: 'sh8_examples', ordinal: 108, vertical: 'salon', body: 'Салон.' }),
  ];
  return (async () => {
    const pick = async (vertical: string) => {
      const { db } = stubDb({ data: rows, error: null });
      const out = await loadPromptSections(db, { tenantId: TENANT, vertical });
      return out.ok ? out.sections.map((x) => x.body) : [];
    };
    assert.deepEqual(await pick('salon'), ['Салон.'], 'the vertical variant wins');
    // And a vertical nobody wrote examples for keeps the generic block rather than losing
    // the gate entirely. V29 is what says the gap exists at all.
    assert.deepEqual(await pick('garage'), ['Ерөнхий.']);
  })();
});

test('order does not decide the winner — the generic row may come second', async () => {
  // The rows arrive in whatever order PostgREST returns them, which is not ordered here.
  // A "last one wins" implementation passes the test above and fails this one.
  const rows = [
    block({ block_key: 'sh8_examples', ordinal: 108, vertical: 'salon', body: 'Салон.' }),
    block({ block_key: 'sh8_examples', ordinal: 108, body: 'Ерөнхий.' }),
  ];
  const { db } = stubDb({ data: rows, error: null });
  const out = await loadPromptSections(db, { tenantId: TENANT, vertical: 'salon' });
  assert.deepEqual(out.ok ? out.sections.map((x) => x.body) : [], ['Салон.']);
});
