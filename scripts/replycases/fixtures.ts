/** Test fixtures shared by the replycases tests. Imported by tests only. */
import { readFileSync } from 'node:fs';
import type { Dump } from '../bakeoff/fixtureDb.ts';

/**
 * Tara's committed dump, brought up to the columns the loader reads today. It predates
 * `deterministic_replies.matcher` (`0048`); a row with no matcher column is a row in any mode
 * but `matcher`, which none of Tara's dumped rows is, so `null` is what the live row holds.
 */
export function taraDump(): Dump {
  const d = JSON.parse(readFileSync('scripts/bakeoff/tara-live.json', 'utf8')) as Dump;
  for (const r of d['deterministic_replies'] ?? []) if (!('matcher' in r)) r['matcher'] = null;
  return d;
}
