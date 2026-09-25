/**
 * A database for answering a test set through `gateTenant` without touching `reply_cases`.
 *
 * `gateTenant` — the D-120 gate the production build runs — loads a tenant's cases from
 * `reply_cases` and its configuration from everything else. To answer a set's case through
 * exactly that code, the case has to come from `reply_cases`; writing it there first would
 * be a write to a live tenant for a read-only measurement, and an ACTIVE row would gate
 * deploys before anybody had read a reply. So `reply_cases` is served from memory and every
 * other table is read from `db` — the live project, or a dump.
 *
 * Read-only by construction, like `scripts/bakeoff/fixtureDb.ts`: every mutating builder
 * method and every `rpc` throws, so a code path that tries to write during a measurement
 * fails loudly instead of writing. (The reply path's own writes are already stubbed by
 * `replycases/run.ts`; this is the second wall, not the first.)
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { fixtureDb } from '../bakeoff/fixtureDb.ts';

const WRITES = new Set(['insert', 'update', 'upsert', 'delete']);

export function withCases(db: SupabaseClient, cases: Record<string, unknown>[]): SupabaseClient {
  const fixture = fixtureDb({ reply_cases: cases });
  const client = {
    from(table: string): unknown {
      const q = (table === 'reply_cases' ? fixture.from(table) : db.from(table)) as object;
      return new Proxy(q, {
        get(target, prop, receiver) {
          if (typeof prop === 'string' && WRITES.has(prop)) {
            return () => { throw new Error(`read-only: ${table}.${prop} was called during a test-set run`); };
          }
          const v: unknown = Reflect.get(target, prop, receiver);
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
    },
    rpc(): never { throw new Error('read-only: rpc was called during a test-set run'); },
  };
  return client as unknown as SupabaseClient;
}
