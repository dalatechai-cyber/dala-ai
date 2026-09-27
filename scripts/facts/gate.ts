/**
 * The fact-consistency gate (founder, 2026-09-27): every copy of a tenant's facts must agree
 * with its rows, or the publish stops. The checker is `src/lib/facts/consistency.ts`; this
 * gathers the copies: the tenant's rows (`loadFactCopies`), the platform's approved lines
 * (`prompt/platform/*.mn.txt`), and the copies outside this project listed in
 * `config/external-fact-copies.json` (the website chatbot). No model, no spend.
 *
 * `external: 'require'` (publish): an external copy that cannot be read is unchecked, and
 * unchecked stops the publish, because a missed copy is how «Маркетинг менежер» survived.
 * `external: 'optional'` (the Vercel build): the sibling checkout is not there, so it is
 * named as not checked in the log, and the rows are still checked.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SupabaseClient } from '@supabase/supabase-js';
import { checkFactCopies, renderFactFindings, type FactCopy } from '../../src/lib/facts/consistency.ts';
import { loadFactCopies } from '../../src/lib/facts/copies.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Comment lines in a JS source are notes about facts, not copies of them. */
export function codeLinesOnly(text: string): string {
  return text.split('\n').filter((l) => !/^\s*(?:\/\/|\*|\/\*)/u.test(l)).join('\n');
}

/** Spelling only: their prices are made-up examples inside rules, never a tenant's price. */
function platformCopies(): FactCopy[] {
  const dir = join(ROOT, 'prompt/platform');
  return readdirSync(dir).filter((f) => f.endsWith('.mn.txt')).sort()
    .map((f) => ({ source: `prompt/platform/${f}`, text: readFileSync(join(dir, f), 'utf8'), prices: false as const }));
}

export function externalPaths(slug: string): string[] {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'config/external-fact-copies.json'), 'utf8')) as Record<string, unknown>;
  const list = cfg[slug];
  return Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string') : [];
}

export async function factGate(
  db: SupabaseClient,
  input: { slug: string; tenantId: string; external: 'require' | 'optional' },
): Promise<{ wrong: string[]; unchecked: string[]; text: string }> {
  const rows = await loadFactCopies(db, input.tenantId);
  if (!rows.ok) return { wrong: [], unchecked: [`${input.slug} facts: ${rows.detail}`], text: `facts: ${input.slug}: UNCHECKED (${rows.detail})` };

  const copies = [...rows.copies, ...platformCopies()];
  const unchecked: string[] = [];
  const notes: string[] = [];
  for (const rel of externalPaths(input.slug)) {
    try {
      copies.push({ source: rel.replace(/^(\.\.\/)+/u, ''), text: codeLinesOnly(readFileSync(resolve(ROOT, rel), 'utf8')) });
    } catch (err) {
      const why = `${rel} unreadable (${err instanceof Error ? err.message.split('\n')[0] : String(err)})`;
      if (input.external === 'require') unchecked.push(`${input.slug} facts: ${why}`);
      else notes.push(`facts: ${input.slug}: not checked in this build: ${rel}`);
    }
  }
  const findings = checkFactCopies(rows.services, copies);
  const text = [renderFactFindings(input.slug, findings), ...notes, ...unchecked.map((u) => `facts: UNCHECKED ${u}`)].join('\n');
  return { wrong: findings.map((f) => `${input.slug} facts: ${f.source}: ${f.detail}`), unchecked, text };
}
