/**
 * Compare the platform blocks a database is actually serving against the signed files.
 *
 * One comparator, so the CI replay and the publisher's live preflight cannot disagree about
 * what "the same" means. This repository's incident list is second implementations
 * disagreeing quietly (D-026's two orderings, D-053's two calendars, D-057's two parsers,
 * D-058's two sources of one canned line).
 *
 * `reviewed_at` is compared as a DATE, not an instant: the sign-off file carries
 * `2026-09-17` and the column carries a timestamptz, so comparing instants would report a
 * difference on every row for ever.
 */
import { readSignedBlocks, type SeedBlock } from './generate-seed.ts';

export type LiveBlock = {
  block_key: string;
  ordinal: number;
  layer: string | null;
  body: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  vertical: string | null;
};

/** A pair, JSON-encoded: no separator character can collide with a block key. */
const key = (blockKey: string, vertical: string | null) => JSON.stringify([blockKey, vertical]);
const day = (v: string | null) => (v === null ? '' : v.slice(0, 10));

/**
 * Every way the live rows differ from the signed files, as sentences.
 *
 * Both directions. A block signed and absent from the database is the case that motivated
 * this; a block live and no longer signed is the one nobody looks for, and it cannot be
 * repaired by running the generator — deleting a row is a destructive migration and
 * founder-gated, so it stays red until a human writes one.
 */
export function comparePlatformBlocks(
  live: readonly LiveBlock[],
  signed: readonly SeedBlock[] = readSignedBlocks(),
): string[] {
  const gaps: string[] = [];
  const liveBy = new Map(live.map((r) => [key(r.block_key, r.vertical), r]));
  const signedBy = new Map(signed.map((b) => [key(b.blockKey, b.vertical), b]));

  for (const [k, b] of signedBy) {
    const name = b.vertical === null ? b.blockKey : `${b.blockKey}.${b.vertical}`;
    const row = liveBy.get(k);
    if (row === undefined) { gaps.push(`${name}: signed, and NOT in the database`); continue; }
    if (row.body !== b.body) gaps.push(`${name}: the live body is not the signed text`);
    if (row.ordinal !== b.ordinal) gaps.push(`${name}: ordinal ${row.ordinal} live, ${b.ordinal} signed`);
    if ((row.layer ?? null) !== b.layer) gaps.push(`${name}: layer ${row.layer ?? 'null'} live, ${b.layer ?? 'null'} signed`);
    if (day(row.reviewed_at) !== day(b.reviewedAt)) {
      gaps.push(`${name}: reviewed_at ${day(row.reviewed_at) || '(none)'} live, ${b.reviewedAt} signed`);
    }
  }
  for (const [k, r] of liveBy) {
    if (signedBy.has(k)) continue;
    const name = r.vertical === null ? r.block_key : `${r.block_key}.${r.vertical}`;
    gaps.push(`${name}: in the database and NOT signed — a delete migration is founder-gated`);
  }
  // Code point, never `localeCompare` (D-026, check-deterministic-order.mjs).
  return gaps.sort();
}
