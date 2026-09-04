import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { buildSeedSql, readSignedBlocks, SEED_PATH } from './generate-seed.ts';

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
