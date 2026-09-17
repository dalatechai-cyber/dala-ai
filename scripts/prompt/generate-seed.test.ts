import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSeedSql, newestSeed, nextSeedPath, readSignedBlocks, seedMigrations, splitVertical } from './generate-seed.ts';

test('DONE-TEST: the NEWEST seed migration is exactly what the signed files produce', () => {
  // Was an equality against a constant `SEED_PATH` = 0010. That assertion and the
  // generator's own docstring contradicted each other the moment a 22nd block was signed:
  // the docstring said an applied file needs a new migration, the test said 0010 must equal
  // the whole signed set. Regenerating 0010 was not merely dishonest about history — its
  // `on conflict (block_key)` cannot be applied at all since 0018 replaced that index
  // (measured: «there is no unique or exclusion constraint matching the ON CONFLICT
  // specification»).
  const newest = newestSeed();
  assert.notEqual(newest, null, 'there must be at least one seed migration');
  assert.equal(
    readFileSync(newest as string, 'utf8'),
    buildSeedSql(),
    `${newest} is stale. Run: node scripts/prompt/generate-seed.ts`,
  );
});

test('DONE-TEST: 0010 IS HISTORY AND IS NEVER REGENERATED', () => {
  // The applied file must keep saying what ran in September. The generator can no longer
  // express writing it: there is no path constant, and the writer allocates max-prefix + 1.
  const all = seedMigrations();
  assert.ok(all.length >= 2, 'expected 0010 plus at least one later seed');
  assert.equal(all[0], 'supabase/migrations/0010_prompt_blocks_seed.sql');
  const first = readFileSync(all[0] as string, 'utf8');
  assert.ok(first.includes("on conflict (block_key) where"), "0010 keeps its pre-0018 conflict target");
  assert.equal(first.includes('02_style'), false, '02_style must not have been written into 0010');
});

test('the next seed is allocated past every existing migration, never at a constant', () => {
  // A constant is exactly what put VERTICAL_SEED_PATH at 0019 while 0019_staff_short_name
  // was already applied — so the first per-vertical block ever signed would have written a
  // SECOND migration numbered 0019.
  const next = path.basename(nextSeedPath());
  const used = readdirSync('supabase/migrations').map((f) => f.slice(0, 4));
  assert.equal(used.includes(next.slice(0, 4)), false, `${next} collides with an existing migration`);
});

test('every signed platform file reaches the migration, and nothing else does', () => {
  const files = readdirSync('prompt/platform').filter((f) => f.endsWith('.mn.txt')).sort();
  const blocks = readSignedBlocks();
  assert.equal(blocks.length, files.length);
  assert.deepEqual(
    blocks.map((b) => b.blockKey),
    files.map((f) => f.slice(0, -'.mn.txt'.length)),
  );

  const sql = readFileSync(newestSeed() as string, 'utf8');
  for (const b of blocks) {
    assert.ok(sql.includes(`'${b.blockKey}'`), `${b.blockKey} missing from the migration`);
    // The BODY, byte for byte. A block whose text reached the file but not the database
    // is the failure this whole mechanism exists to make impossible.
    assert.ok(sql.includes(b.body), `${b.blockKey}'s body is not in the migration verbatim`);
  }
});

test('DONE-TEST: an unsigned block cannot be seeded, even with the guard skipped', () => {
  // check-mn-review.mjs is a build gate and gates can be run out of order. Refusing here
  // too means there is no sequence of commands that seeds Mongolian nobody read.
  assert.throws(
    () => readSignedBlocks('/nonexistent-root-for-this-test'),
    /ENOENT|no sign-off/,
  );
});

test('the boundary gate is L0 and in wire order; the other two families are not prompt sections', () => {
  const blocks = readSignedBlocks();
  const gate = blocks.filter((b) => b.layer === 'L0').sort((a, b) => a.ordinal - b.ordinal);
  assert.deepEqual(gate.map((b) => b.blockKey), [
    '00_gate_preamble', '01_data_marker', '02_style',
    'sh0_channel', 'sh1_refusal_topics', 'sh2_price', 'sh3_booking', 'sh4_staff_schedule',
    'sh5_health', 'sh6_concessions', 'sh7_abuse_offtopic', 'sh8_not_in_kb',
    'sh9_instruction_disclosure',
  ]);

  // `layer is null` means "customer-visible Mongolian something OTHER than the prompt
  // compiler renders". Both families here are read by name, never by layer, so a wrong
  // layer would put a status-page string into every tenant's system prompt.
  const notSections = blocks.filter((b) => b.layer === null).map((b) => b.blockKey).sort();
  assert.deepEqual(notSections, [
    'comment_public_reply',
    'data_deletion_code_label', 'data_deletion_intro', 'data_deletion_not_found',
    'data_deletion_requested_label', 'data_deletion_state_completed',
    'data_deletion_state_failed', 'data_deletion_state_received', 'data_deletion_title',
  ]);
});

test('every block is NFC and carries an attributed sign-off', () => {
  for (const b of readSignedBlocks()) {
    assert.equal(b.body.normalize('NFC'), b.body, b.blockKey);
    assert.notEqual(b.body.trim(), '', b.blockKey);
    assert.ok(b.reviewedBy.length > 0, b.blockKey);
    assert.match(b.reviewedAt, /^\d{4}-\d{2}-\d{2}/); // ascii-safe: an ISO date
  }
});

test('DONE-TEST: the comment template is seeded platform-side and no runtime reads it', () => {
  // The template exists so ONBOARDING can copy it into a tenant's `canned_responses` row.
  // If any runtime reader ever falls back to it, a salon posts a sentence Dalatech wrote,
  // in the salon's voice, under the salon's own post — the failure `eligibility.ts`
  // refuses by design and the reason it is not given a platform default to reach for.
  //
  // Asserted structurally rather than by grepping a comment: no file on the comment path
  // may mention `prompt_blocks` at all, so a fallback cannot be added without deleting
  // this test. The refusal ITSELF is behaviour and is tested in eligibility.test.ts as
  // `no_reviewed_line`; this covers the one thing that test cannot see, which is where
  // the body could come from.
  for (const file of [
    'src/lib/worker/comments.ts',
    'src/lib/comments/eligibility.ts',
    'src/lib/comments/send.ts',
  ]) {
    assert.ok(
      !readFileSync(file, 'utf8').includes('prompt_blocks'),
      `${file} must read canned_responses only, never the platform template`,
    );
  }
});

// ---------------------------------------------------------------------------
// 0018/0019 — per-vertical blocks
// ---------------------------------------------------------------------------

/** A fixture root with its own `prompt/platform` and sign-off. */
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'seed-'));
  mkdirSync(path.join(root, 'prompt', 'platform'), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(path.join(root, 'prompt', 'platform', name), body);
  }
  writeFileSync(path.join(root, 'prompt', 'platform-mn-review.json'), JSON.stringify({
    blocks: Object.keys(files).map((f) => ({
      block_id: f.slice(0, -'.mn.txt'.length), sha256: 'x', reviewed_by: 'Bilguun', reviewed_at: '2026-09-07',
    })),
  }));
  return root;
}

test('the filename carries the vertical, and a block without one applies to everybody', () => {
  assert.deepEqual(splitVertical('sh8_not_in_kb'), { key: 'sh8_not_in_kb', vertical: null });
  assert.deepEqual(splitVertical('sh8_examples.salon'), { key: 'sh8_examples', vertical: 'salon' });
  assert.deepEqual(splitVertical('sh8_examples.software'), { key: 'sh8_examples', vertical: 'software' });
});

test('DONE-TEST: A PER-VERTICAL BLOCK REACHES THE SAME FILE AS A GENERIC ONE', () => {
  // Replaces two tests built on VERTICAL_SEED_PATH — a CONSTANT pointing at 0019 while
  // 0019_staff_short_name.sql is applied, so the first per-vertical block ever signed would
  // have written a second migration numbered 0019. The four gate blocks waiting on the
  // reading evening are exactly that case.
  //
  // The split existed only because the generator could not allocate a number. A
  // per-vertical block is just a row whose `vertical` is not null, and the conflict target
  // `coalesce(vertical, '')` lets it sit beside its generic twin.
  const root = mkdtempSync(path.join(tmpdir(), 'seed-vertical-'));
  mkdirSync(path.join(root, 'prompt/platform'), { recursive: true });
  const write = (name: string, body: string) =>
    writeFileSync(path.join(root, 'prompt/platform', name), body);
  write('sh8_not_in_kb.mn.txt', 'Ш8 ерөнхий\n');
  write('sh8_not_in_kb.salon.mn.txt', 'Ш8 жишээ салон\n');
  writeFileSync(path.join(root, 'prompt/platform-mn-review.json'), JSON.stringify({
    blocks: [
      { block_id: 'sh8_not_in_kb', sha256: 'x', reviewed_by: 'B', reviewed_at: '2026-09-04' },
      { block_id: 'sh8_not_in_kb.salon', sha256: 'y', reviewed_by: 'B', reviewed_at: '2026-09-17' },
    ],
  }));

  const sql = buildSeedSql(root);
  assert.ok(sql.includes('Ш8 ерөнхий'), 'the generic block is in the file');
  assert.ok(sql.includes('Ш8 жишээ салон'), 'and so is the per-vertical one — same file');
  assert.ok(sql.includes("'salon'"), 'the vertical is carried as a column value');
  assert.ok(
    sql.includes("on conflict (block_key, coalesce(vertical, ''))"),
    'the conflict target is the index 0018 created, so both rows can coexist',
  );
});

test('an unsigned per-vertical block is refused like any other', () => {
  const root = fixture({ 'sh0_channel.mn.txt': 'Ш0.\n' });
  writeFileSync(path.join(root, 'prompt', 'platform', 'sh8_examples.salon.mn.txt'), 'Ш8.\n');
  assert.throws(() => readSignedBlocks(root), /no sign-off/);
});
