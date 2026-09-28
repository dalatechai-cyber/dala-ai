/**
 * The founder's signature on a directory of platform-block drafts, in one command.
 *
 *     # read: lists every file, its sha256, and the SET ID covering all of them
 *     node scripts/prompt/sign-drafts.ts --dir prompt/drafts/vertical-neutral
 *
 *     # sign exactly that set
 *     node scripts/prompt/sign-drafts.ts --dir prompt/drafts/vertical-neutral --set <set id> --by Bilguun
 *
 * Signing MOVES each file into `prompt/platform/` (a draft replaces the block of the same
 * name), writes its entry in `prompt/platform-mn-review.json`, writes the next
 * `*_prompt_blocks_seed.sql` and its `docs/schema.md` entry, then prints the push steps. It is what the README's promotion
 * checklist describes by hand, with one guard the hand version lacks: the set id is a hash
 * of every file's name and bytes, so a file changed after it was read is not signed.
 *
 * ## Frozen copies keep their original signature
 *
 * A file byte-identical to a block already signed (e.g. `sh3_booking.salon.mn.txt`, today's
 * `sh3_booking` frozen for the salon vertical) carries that block's `reviewed_by` and
 * `reviewed_at` forward: the founder signed those bytes on that date, and the live tenants'
 * rows then match the signed set exactly, date included (`comparePlatformBlocks`).
 *
 * Writes files only in this checkout. Touches no database and no model.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ubDate } from '../../src/lib/time/ub.ts';
import { buildSeedSql, nextSeedPath, readSignedBlocks } from './generate-seed.ts';

const PLATFORM = 'prompt/platform';
const SIGNOFF = 'prompt/platform-mn-review.json';

function die(m: string): never { process.stderr.write(`sign-drafts: ${m}\n`); process.exit(2); }
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? undefined : process.argv[i + 1]; };

const dir = arg('dir') ?? die('--dir <drafts directory> is required');
const setId = arg('set');
const by = arg('by');
if (setId !== undefined && (by === undefined || by.trim() === '')) die('--set needs --by <your name>');

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const files = readdirSync(dir).filter((f) => f.endsWith('.mn.txt')).sort();
if (files.length === 0) die(`no .mn.txt files in ${dir}`);
const entries = files.map((f) => {
  const bytes = readFileSync(path.join(dir, f));
  const text = bytes.toString('utf8');
  if (text !== text.normalize('NFC')) die(`${f} is not NFC-normalised`);
  return { file: f, blockId: f.slice(0, -'.mn.txt'.length), sha256: sha(bytes) };
});
const set = sha(entries.map((e) => `${e.file}\u0000${e.sha256}`).join('\n')).slice(0, 12);

type Entry = { block_id: string; sha256: string; reviewed_by: string; reviewed_at: string };
const signoff = JSON.parse(readFileSync(SIGNOFF, 'utf8')) as { blocks: Entry[] } & Record<string, unknown>;
const bySha = new Map(signoff.blocks.map((b) => [b.sha256, b]));

const out = (s = '') => process.stdout.write(`${s}\n`);
out(`${entries.length} drafts in ${dir}:`);
for (const e of entries) {
  const same = bySha.get(e.sha256);
  const replaces = existsSync(path.join(PLATFORM, e.file)) ? ' (replaces the signed block of this name)' : '';
  out(`  ${e.file.padEnd(40)} ${e.sha256.slice(0, 12)}  ${same === undefined ? `NEW TEXT${replaces}` : `same bytes as signed «${same.block_id}» (${same.reviewed_by}, ${same.reviewed_at})`}`);
}
out(`\nset id: ${set}`);

if (setId === undefined) {
  out(`\nTo sign exactly these files:\n  node scripts/prompt/sign-drafts.ts --dir ${dir} --set ${set} --by <your name>`);
  process.exit(0);
}
if (setId !== set) die(`set ${setId} is not the files in ${dir} now (${set}): something changed since it was read`);

const today = ubDate(new Date());
for (const e of entries) {
  const same = bySha.get(e.sha256);
  const entry: Entry = {
    block_id: e.blockId, sha256: e.sha256,
    reviewed_by: same?.reviewed_by ?? by!, reviewed_at: same?.reviewed_at ?? today,
  };
  const i = signoff.blocks.findIndex((b) => b.block_id === e.blockId);
  if (i === -1) signoff.blocks.push(entry); else signoff.blocks[i] = entry;
  renameSync(path.join(dir, e.file), path.join(PLATFORM, e.file));
}
// Code point, never localeCompare (D-026).
signoff.blocks.sort((a, b) => (a.block_id < b.block_id ? -1 : a.block_id > b.block_id ? 1 : 0));
writeFileSync(SIGNOFF, `${JSON.stringify(signoff, null, 2)}\n`);
// The seed migration and its schema.md entry, written here so the founder's one command
// leaves a checkout that passes every guard (check-mn-review, check-schema-doc,
// generate-seed --check). Same generator as `node scripts/prompt/generate-seed.ts`.
const seedPath = nextSeedPath();
writeFileSync(seedPath, buildSeedSql(), { flag: 'wx' });
const seedName = path.basename(seedPath, '.sql');
const fresh = entries.filter((e) => !bySha.has(e.sha256)).map((e) => `\`${e.blockId}\``);
const frozen = entries.length - fresh.length;
const doc = readFileSync('docs/schema.md', 'utf8');
const at = doc.search(/^### `\d{4}_/mu);
if (at === -1) die('docs/schema.md has no migration entries to insert before');
const entry = `### \`${seedName}\`\n\n**No DDL.** Generated by \`node scripts/prompt/sign-drafts.ts\` after the founder signed `
  + `the drafts in \`${dir}\` (${today}). ${readSignedBlocks().length} blocks. New text: ${fresh.join(', ')}. `
  + `${frozen} per-vertical rows carry today's text byte for byte, with its original signature, so a tenant `
  + 'whose vertical has its own row compiles exactly as before; every other vertical reads the new generic text. '
  + 'It applies to each tenant at its next publish.\n\n';
writeFileSync('docs/schema.md', doc.slice(0, at) + entry + doc.slice(at));

out(`\nsigned ${entries.length} blocks by ${by} (${today}, Ulaanbaatar; frozen copies keep their original date).`);
out(`wrote ${seedPath} and its docs/schema.md entry.`);
out('Next, in order:');
out('  1. node scripts/guards/check-mn-review.mjs && npm test');
out('  2. git add -A && git commit -m "Sign the vertical-neutral gate blocks" && git push');
out('  3. supabase db push                            # the seed, to the project');
out('  4. read the ledger: select max(version) from supabase_migrations.schema_migrations;');
