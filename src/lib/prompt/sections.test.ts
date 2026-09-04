import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileAndPublish, compileStablePrefix, loadPromptSections } from './sections.ts';
import { renderStablePrefix, type PromptSection } from './render.ts';

const TENANT = '11111111-0000-4000-8000-000000000001';

type Row = Record<string, unknown>;

function block(over: Row = {}): Row {
  return {
    scope: 'platform', tenant_id: null, block_key: 'sh0_channel', ordinal: 100,
    layer: 'L0', body: 'Ш0. СУВАГ.', reviewed_at: '2026-09-04T00:00:00Z', ...over,
  };
}

function stubDb(reply: { data?: unknown; error?: unknown }) {
  const calls: { table: string; cols: string; filter: string }[] = [];
  const from = (table: string) => {
    const rec = { table, cols: '', filter: '' };
    calls.push(rec);
    const chain: Record<string, unknown> = {};
    chain['select'] = (cols: string) => ((rec.cols = cols), chain);
    chain['or'] = (f: string) => ((rec.filter = f), chain);
    chain['then'] = (res: (v: unknown) => unknown) => res(reply);
    return chain;
  };
  return { calls, db: { from } as never };
}

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
  const out = await loadPromptSections(db, { tenantId: TENANT });
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
  const loaded = await loadPromptSections(db, { tenantId: TENANT });
  assert.equal(loaded.ok && loaded.sections.length, 2, 'both loaded — the unreviewed one is not dropped');

  const compiled = await compileStablePrefix(db, { tenantId: TENANT });
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
  const out = await compileStablePrefix(db, { tenantId: TENANT });
  assert.equal(out.ok, false);
  assert.equal(out.ok === false && out.code, 'no_gate');
});

test('the read is scoped to this tenant and to platform rows, never across tenants', async () => {
  // These queries run under service_role, which holds BYPASSRLS — there is no policy
  // adding the tenant filter, so its absence would pull every tenant's blocks into one
  // prompt.
  const { db, calls } = stubDb({ data: [block()], error: null });
  await loadPromptSections(db, { tenantId: TENANT });
  assert.equal(calls[0]?.table, 'prompt_blocks');
  assert.ok(calls[0]?.filter.includes(`tenant_id.eq.${TENANT}`));
  assert.ok(calls[0]?.filter.includes('scope.eq.platform'));
  assert.ok(calls[0]?.filter.includes('tenant_id.is.null'));
  assert.equal(calls.length, 1, 'one query — two could straddle a publish and mix configurations');
});

test('an unreadable table is unavailable, never an empty prompt', async () => {
  const { db } = stubDb({ error: { message: 'reset' } });
  const out = await compileStablePrefix(db, { tenantId: TENANT });
  assert.equal(out.ok === false && out.code, 'unavailable');
});

test('scope becomes origin, so a tenant row can never claim a platform layer unnoticed', async () => {
  const { db } = stubDb({
    data: [block(), block({ scope: 'tenant', tenant_id: TENANT, block_key: 'sneaky', layer: 'L0', ordinal: 1 })],
    error: null,
  });
  const out = await compileStablePrefix(db, { tenantId: TENANT });
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
  const out = await loadPromptSections(db, { tenantId: TENANT });
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
// The whole chain: blocks → sections → prefix → snapshot
// ---------------------------------------------------------------------------

/** A db that answers each table by name, recording every write. */
function chainDb(over: Record<string, { data?: unknown; error?: unknown }> = {}) {
  const writes: { table: string; op: string; patch: Record<string, unknown>[] }[] = [];
  const answer = (table: string) =>
    over[table] ?? { data: table === 'config_revisions' ? { status: 'draft' } : null, error: null };
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'neq', 'or', 'is']) chain[m] = () => chain;
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
