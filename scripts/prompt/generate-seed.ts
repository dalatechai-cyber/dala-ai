/**
 * Turn the signed platform blocks into a seed migration.
 *
 * `prompt/README.md` has always said "the seed loads the file into `prompt_blocks` with
 * that `reviewed_at`". No such seed existed — the gate was built before the thing it
 * gates, deliberately, and then the blocks arrived and the wire between them did not.
 * This is that wire.
 *
 * ## Why generated rather than hand-written
 *
 * A migration cannot read a file: it runs inside Postgres, from a `.sql` text. So the
 * Mongolian has to be *copied* into SQL, and a copy is exactly what D-020 says will drift
 * — here from the file that carries the native speaker's signature, which is the one copy
 * that means anything.
 *
 * So the copy is mechanical and the drift is a test failure:
 *
 *   - `buildSeedSql()` derives the whole migration from `prompt/platform/*.mn.txt` plus
 *     `prompt/platform-mn-review.json`.
 *   - The CLI writes it to `supabase/migrations/0010_prompt_blocks_seed.sql`.
 *   - `generate-seed.test.ts` asserts the checked-in file equals `buildSeedSql()`, so a
 *     block edited without regenerating fails CI rather than shipping a database whose
 *     text differs from the signed one.
 *
 * The signature still lives on the FILE, not on this output. That ordering matters: the
 * hash signs what a native speaker read, and the migration is downstream of it.
 *
 * Usage: `node scripts/prompt/generate-seed.ts` (writes), `--check` (exit 1 if stale).
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PLATFORM_DIR = 'prompt/platform';
const SIGNOFF = 'prompt/platform-mn-review.json';

/**
 * Dollar-quoting, so nothing in the Mongolian needs escaping and no apostrophe can end a
 * string early. The tag is asserted absent from every body rather than assumed.
 */
const TAG = '$mn$';

/**
 * The compiled prompt's layer, per block. `null` means **not part of the compiled
 * prompt** — the block is customer-visible Mongolian that something else renders.
 *
 * This is a map rather than a filename convention because the two families that are not
 * prompt sections are not distinguishable by name from ones that might be later, and a
 * convention that has to be remembered is the kind D-020 is about.
 */
function layerFor(blockKey: string): 'L0' | null {
  if (blockKey.startsWith('data_deletion_')) return null; // the status page renders these
  if (blockKey === 'comment_public_reply') return null; // a canned_responses template
  // Everything else is the boundary gate: the L0 scaffold, ahead of every tenant section,
  // which is what makes it one cache entry for the whole platform (render.ts's note).
  return 'L0';
}

export type SeedBlock = {
  blockKey: string;
  ordinal: number;
  layer: 'L0' | null;
  body: string;
  reviewedBy: string;
  reviewedAt: string;
  /** `null` means every tenant; a value means only tenants with that `tenants.vertical`. */
  vertical: string | null;
};

/**
 * `sh8_not_in_kb_examples.salon.mn.txt` → key `sh8_not_in_kb_examples`, vertical `salon`.
 *
 * A convention rather than a map, which is the opposite of `layerFor`'s choice, and the
 * reason differs: the two non-prompt families are not distinguishable by name from ones
 * that might be added later, whereas a vertical IS the distinguishing fact and putting it
 * in the filename keeps the sign-off — which is over the file — attached to the variant a
 * native speaker actually read. A block with no suffix applies to every tenant.
 */
export function splitVertical(blockKey: string): { key: string; vertical: string | null } {
  const dot = blockKey.lastIndexOf('.');
  if (dot <= 0) return { key: blockKey, vertical: null };
  return { key: blockKey.slice(0, dot), vertical: blockKey.slice(dot + 1) };
}

/** Gate blocks in wire order. `00`/`01` first, then Ш0–Ш9 by their numeric index. */
function gateOrder(blockKey: string): number {
  const sh = /^sh(\d+)_/.exec(blockKey); // ascii-safe: a filename prefix, ASCII by construction
  if (sh !== null) return 100 + Number(sh[1]);
  const numbered = /^(\d+)_/.exec(blockKey); // ascii-safe: as above
  return numbered !== null ? Number(numbered[1]) : 0;
}

export function readSignedBlocks(root = process.cwd()): SeedBlock[] {
  const signoff = JSON.parse(readFileSync(path.join(root, SIGNOFF), 'utf8')) as {
    blocks: { block_id: string; sha256: string; reviewed_by: string; reviewed_at: string }[];
  };
  const byId = new Map(signoff.blocks.map((b) => [b.block_id, b]));

  const files = readdirSync(path.join(root, PLATFORM_DIR))
    .filter((f) => f.endsWith('.mn.txt'))
    .sort();

  const blocks: SeedBlock[] = [];
  for (const file of files) {
    // The sign-off is keyed by the FILE's stem, suffix included: a native speaker signs the
    // salon examples and the software examples separately, because they are separate text.
    const blockKey = file.slice(0, -'.mn.txt'.length);
    const body = readFileSync(path.join(root, PLATFORM_DIR, file), 'utf8');
    const entry = byId.get(blockKey);
    if (entry === undefined) {
      // check-mn-review.mjs already fails on this; refusing here too means the seed can
      // never be generated from an unsigned block even if the guard is skipped.
      throw new Error(`${file} has no sign-off in ${SIGNOFF}. Refusing to seed unreviewed Mongolian.`);
    }
    if (body.includes(TAG)) throw new Error(`${file} contains ${TAG}, which would end the SQL literal early.`);
    if (body.normalize('NFC') !== body) throw new Error(`${file} is not NFC-normalised.`);
    const { key, vertical } = splitVertical(blockKey);
    blocks.push({
      blockKey: key,
      ordinal: layerFor(key) === null ? 0 : gateOrder(key),
      layer: layerFor(key),
      body,
      reviewedBy: entry.reviewed_by,
      reviewedAt: entry.reviewed_at,
      vertical,
    });
  }
  return blocks;
}

/**
 * Every seed migration, oldest first. The selector is the FILENAME suffix.
 *
 * `0010` is in here and is never rewritten — it is what ran in September, and its
 * `on conflict (block_key)` cannot even be re-applied today: `0018` replaced that index
 * with one over `(block_key, coalesce(vertical, ''))`, and Postgres answers the old target
 * with «there is no unique or exclusion constraint matching the ON CONFLICT specification»
 * (measured, PG16.13, 0001–0027 applied).
 */
export function seedMigrations(root = process.cwd()): string[] {
  return readdirSync(path.join(root, 'supabase/migrations'))
    .filter((f) => f.endsWith('_prompt_blocks_seed.sql'))
    // Code point, never `localeCompare` — `check-deterministic-order.mjs` and D-026.
    .sort()
    .map((f) => path.join('supabase/migrations', f));
}

/** The seed the database ends on, because Postgres applies migrations in order. */
export function newestSeed(root = process.cwd()): string | null {
  const all = seedMigrations(root);
  return all.length === 0 ? null : (all[all.length - 1] as string);
}

/**
 * The next seed's path: the highest four-digit prefix in the directory, plus one.
 *
 * Read from the directory rather than held as a constant — a constant is what put
 * `VERTICAL_SEED_PATH` at `0019` while `0019_staff_short_name.sql` was already applied, so
 * the first per-vertical block ever signed would have written a SECOND migration numbered
 * 0019. CLAUDE.md forbids reading the migration COUNT off `ls`, and this is not that: it is
 * allocating the next free name, and the allocation is checked afterwards by reading the
 * ledger (the operator's step 2) and by the publisher's preflight.
 */
export function nextSeedPath(root = process.cwd()): string {
  const prefixes = readdirSync(path.join(root, 'supabase/migrations'))
    .map((f) => Number.parseInt(f.slice(0, 4), 10))
    .filter((n) => Number.isInteger(n));
  const next = String(Math.max(0, ...prefixes) + 1).padStart(4, '0');
  return path.join('supabase/migrations', `${next}_prompt_blocks_seed.sql`);
}

/**
 * One line per row: what a reviewer reads instead of 20KB of regenerated Mongolian.
 *
 * Emitted from the same array that emits the tuples, so it cannot drift from them. A
 * one-block change moves two lines of this table, which is the whole point — a full-set
 * migration is unreviewable without it.
 */
function manifest(blocks: readonly SeedBlock[]): string {
  const rows = blocks.map((b) =>
    `--   ${b.blockKey.padEnd(28)} ${(b.vertical ?? '-').padEnd(9)} ` +
    `${String(b.ordinal).padStart(3)}  ${(b.layer ?? 'null').padEnd(4)} ` +
    `${createHash('sha256').update(b.body).digest('hex').slice(0, 12)}  ${b.reviewedAt}`);
  return (
    `--   ${'block_key'.padEnd(28)} ${'vertical'.padEnd(9)} ord  layer sha256[0:12]  signed\n` +
    `--   ${'-'.repeat(28)} ${'-'.repeat(9)} ---  ----- ------------  ----------\n` +
    `${rows.join('\n')}\n`
  );
}

/**
 * The full signed set, as one convergent upsert, for a NEW migration.
 *
 * ## Convergent, never a delta — this is the load-bearing choice
 *
 * A delta chain computes "what the database already has" from the REPO. So a push that is
 * missed or skipped is permanent AND self-concealing: the generator finds the block present
 * in the unpushed file, excludes it from every future delta, and reports "nothing changed"
 * for ever. A full-set upsert self-heals — the next seed re-asserts every row, so the
 * repair is the ordinary next commit rather than a hand-written migration nobody knows to
 * write.
 *
 * Measured cost of convergence: zero. `prompt_blocks` has no triggers and no `updated_at`,
 * so re-upserting unchanged rows writes nothing anybody reads.
 *
 * Generic and per-vertical blocks are ONE family in ONE file. The old split existed only
 * because the generator could not allocate a migration number; a per-vertical block is just
 * a row whose `vertical` is not null, and `coalesce(vertical, '')` in the conflict target
 * lets it sit beside its generic twin.
 */
export function buildSeedSql(root = process.cwd()): string {
  const blocks = readSignedBlocks(root);
  const values = blocks
    .map((b) => {
      const layer = b.layer === null ? 'null' : `'${b.layer}'`;
      const vertical = b.vertical === null ? 'null' : `'${b.vertical}'`;
      return (
        `  ('platform', null, '${b.blockKey}', ${b.ordinal}, ${layer},\n` +
        `   ${TAG}${b.body}${TAG},\n` +
        `   '${b.reviewedBy}', '${b.reviewedAt}'::timestamptz, ${vertical})`
      );
    })
    .join(',\n');

  return (
    `-- The signed platform Mongolian, seeded into \`prompt_blocks\` — the FULL set.\n` +
    `--\n` +
    `-- GENERATED by scripts/prompt/generate-seed.ts from prompt/platform/*.mn.txt and\n` +
    `-- prompt/platform-mn-review.json. Do not edit by hand.\n` +
    `--\n` +
    `-- Every seed migration carries every signed block as an idempotent upsert, so the end\n` +
    `-- state is this file and a missed push is repaired by the next one rather than lost.\n` +
    `-- Earlier seeds stay exactly as they ran; this tool cannot open an existing file.\n` +
    `--\n` +
    `-- The signature lives on the FILE (prompt/platform-mn-review.json, by sha256), not on\n` +
    `-- this table. These columns carry that attribution so the runtime's\n` +
    `-- \`reviewed_at is not null\` gate passes. If the two disagree, the file is right.\n` +
    `--\n` +
    `-- ROWS:\n` +
    manifest(blocks) +
    `\n` +
    `insert into prompt_blocks (scope, tenant_id, block_key, ordinal, layer, body, reviewed_by, reviewed_at, vertical)\n` +
    `values\n${values}\n` +
    `on conflict (block_key, coalesce(vertical, '')) where scope = 'platform' and tenant_id is null do update set\n` +
    `  ordinal     = excluded.ordinal,\n` +
    `  layer       = excluded.layer,\n` +
    `  body        = excluded.body,\n` +
    `  reviewed_by = excluded.reviewed_by,\n` +
    `  reviewed_at = excluded.reviewed_at;\n`
  );
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('generate-seed.ts')) {
  const want = buildSeedSql();
  const newest = newestSeed();
  const current = newest === null ? null : readFileSync(newest, 'utf8');

  if (process.argv.includes('--check')) {
    if (current === want) {
      process.stdout.write(`${newest} is up to date (${readSignedBlocks().length} signed blocks).\n`);
    } else {
      process.stderr.write(
        `${newest ?? '(no seed migration)'} does not carry the signed set.\n` +
        `Run: node scripts/prompt/generate-seed.ts\n`,
      );
      process.exit(1);
    }
  } else if (current === want) {
    // Without this a new-file scheme mints a migration on every invocation.
    process.stdout.write(`up to date; ${newest} already carries all ${readSignedBlocks().length} signed blocks.\n`);
  } else {
    const target = nextSeedPath();
    // `wx` is an EEXIST from the OPERATING SYSTEM, not a policy this tool applies to
    // itself. The defect being fixed here is a docstring that described a control nobody
    // implemented — the `meta/extract.ts` and `config/platform.ts:33` shape, third
    // instance — so the replacement is a structure that cannot be talked out of.
    // There is deliberately no --force.
    writeFileSync(target, want, { flag: 'wx' });
    process.stdout.write(
      `wrote ${target} (${readSignedBlocks().length} signed blocks, full set).\n` +
      `Push it, then read the ledger: select count(*), max(version) from supabase_migrations.schema_migrations;\n`,
    );
  }
}
