import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSeedSql, buildVerticalSeedSql, readSignedBlocks, splitVertical, SEED_PATH, VERTICAL_SEED_PATH } from './generate-seed.ts';

test('DONE-TEST: the checked-in migration is exactly what the signed files produce', () => {
  // The whole reason this generator exists. The Mongolian has to be COPIED into SQL —
  // a migration cannot read a file — and a copy of signed text is precisely what D-020
  // says will drift, here from the one copy carrying a native speaker's signature.
  // Regenerating and comparing turns that drift into a red build.
  assert.equal(
    readFileSync(SEED_PATH, 'utf8'),
    buildSeedSql(),
    `${SEED_PATH} is stale. Run: node scripts/prompt/generate-seed.ts`,
  );
});

test('every signed platform file reaches the migration, and nothing else does', () => {
  const files = readdirSync('prompt/platform').filter((f) => f.endsWith('.mn.txt')).sort();
  const blocks = readSignedBlocks();
  assert.equal(blocks.length, files.length);
  assert.deepEqual(
    blocks.map((b) => b.blockKey),
    files.map((f) => f.slice(0, -'.mn.txt'.length)),
  );

  const sql = readFileSync(SEED_PATH, 'utf8');
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
    '00_gate_preamble', '01_data_marker',
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

test('DONE-TEST: TODAY THERE IS NO 0019, and the generator says so rather than writing an empty one', () => {
  // The founder approved the shape and deliberately did not schedule the reading evening.
  // Until the drafts are signed and moved into `prompt/platform`, nothing per-vertical is
  // seeded — and an empty migration in a directory whose contract is "these get pushed"
  // would be a file that claims work nobody did.
  assert.equal(buildVerticalSeedSql(), null);
  assert.equal(existsSync(VERTICAL_SEED_PATH), false, `${VERTICAL_SEED_PATH} must not exist yet`);
});

test('a signed per-vertical block seeds into 0019, NEVER into 0010', () => {
  // 0010 is applied to the project. A generator that rewrote it would produce a migration
  // that no longer describes what ran — the same class of untruth as a schema doc that
  // has drifted from the schema.
  const root = fixture({
    'sh0_channel.mn.txt': 'Ш0. СУВАГ.\n',
    'sh8_examples.salon.mn.txt': 'Ш8 жишээ: салон.\n',
    'sh8_examples.software.mn.txt': 'Ш8 жишээ: софтвэр.\n',
  });
  const shared = buildSeedSql(root);
  assert.ok(shared.includes('Ш0. СУВАГ.'));
  assert.equal(shared.includes('Ш8 жишээ'), false, 'a per-vertical block must not reach 0010');

  const perVertical = buildVerticalSeedSql(root) ?? '';
  assert.ok(perVertical.includes("'salon'") && perVertical.includes("'software'"));
  assert.ok(perVertical.includes('Ш8 жишээ: салон.') && perVertical.includes('Ш8 жишээ: софтвэр.'));
  // Both variants share one block_key, which is exactly what 0018 relaxed the index for.
  assert.equal((perVertical.match(/'sh8_examples'/g) ?? []).length, 2);
  assert.ok(perVertical.includes("on conflict (block_key, coalesce(vertical, ''))"));
});

test('an unsigned per-vertical block is refused like any other', () => {
  const root = fixture({ 'sh0_channel.mn.txt': 'Ш0.\n' });
  writeFileSync(path.join(root, 'prompt', 'platform', 'sh8_examples.salon.mn.txt'), 'Ш8.\n');
  assert.throws(() => readSignedBlocks(root), /no sign-off/);
});
