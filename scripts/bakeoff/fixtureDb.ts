/**
 * A READ-ONLY stand-in for the Supabase client, serving rows dumped from the live project.
 *
 * It exists so the bake-off can run the REAL loader (`loadReceptionContext`) and the REAL case
 * runner (`replycases/run.ts`) — the code a customer is answered by — without a database key and
 * without any chance of writing to a live tenant. A reimplementation of the loader here would
 * measure the reimplementation; serving its queries from a dump measures the loader.
 *
 * It implements exactly the query shapes those two read, and REFUSES everything else by
 * throwing: an unsupported filter answered approximately would be the quietest possible way to
 * test a different configuration from the live one. Every mutating method throws too, so a code
 * path that tries to write during a bake-off fails loudly instead of doing nothing.
 *
 * The dump's faithfulness is checked, not assumed: `arms.ts` refuses to run unless the dumped
 * snapshot's `prompt_stable` hashes to its own `content_hash`.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

type Row = Record<string, unknown>;
export type Dump = Record<string, Row[] | null>;

type Filter = (row: Row) => boolean;

function project(row: Row, columns: string): Row {
  if (columns.trim() === '*') return { ...row };
  const out: Row = {};
  for (const raw of columns.split(',')) {
    const col = raw.trim();
    if (col === '') continue;
    if (/[()!:]/.test(col)) throw new Error(`fixtureDb: embedded or aliased select «${col}» is not supported`);
    if (!(col in row)) throw new Error(`fixtureDb: column «${col}» is not in the dump`);
    out[col] = row[col];
  }
  return out;
}

/** `tenant_id.is.null,tenant_id.eq.<uuid>` — the one `.or()` shape the loader uses. */
function parseOr(expr: string): Filter {
  const parts = expr.split(',').map((p) => {
    const m = /^([a-z_]+)\.(is|eq)\.(.*)$/.exec(p.trim());
    if (m === null) throw new Error(`fixtureDb: .or() term «${p}» is not supported`);
    const [, col, op, val] = m as unknown as [string, string, string, string];
    if (op === 'is') {
      if (val !== 'null') throw new Error(`fixtureDb: .or() «is.${val}» is not supported`);
      return (r: Row) => r[col] === null || r[col] === undefined;
    }
    return (r: Row) => String(r[col]) === val;
  });
  return (r) => parts.some((f) => f(r));
}

class Query implements PromiseLike<{ data: unknown; error: null }> {
  private filters: Filter[] = [];
  private columns = '*';
  private orderBy: { col: string; asc: boolean }[] = [];
  private cap: number | null = null;
  private mode: 'many' | 'maybeSingle' | 'single' = 'many';

  private readonly table: string;
  private readonly rows: Row[];
  constructor(table: string, rows: Row[]) { this.table = table; this.rows = rows; }

  select(columns = '*'): this { this.columns = columns; return this; }
  eq(col: string, val: unknown): this { this.filters.push((r) => r[col] === val || String(r[col]) === String(val)); return this; }
  is(col: string, val: null): this {
    if (val !== null) throw new Error('fixtureDb: .is() supports null only');
    this.filters.push((r) => r[col] === null || r[col] === undefined); return this;
  }
  in(col: string, vals: readonly unknown[]): this { this.filters.push((r) => vals.map(String).includes(String(r[col]))); return this; }
  // ISO dates and timestamps compare correctly as strings; anything else is refused.
  gte(col: string, val: string): this {
    if (!/^\d{4}-\d{2}-\d{2}/.test(val)) throw new Error(`fixtureDb: .gte() on a non-date «${val}»`);
    this.filters.push((r) => r[col] !== null && String(r[col]) >= val); return this;
  }
  or(expr: string): this { this.filters.push(parseOr(expr)); return this; }
  order(col: string, opts?: { ascending?: boolean }): this { this.orderBy.push({ col, asc: opts?.ascending !== false }); return this; }
  limit(n: number): this { this.cap = n; return this; }
  maybeSingle(): this { this.mode = 'maybeSingle'; return this; }
  single(): this { this.mode = 'single'; return this; }

  private run(): { data: unknown; error: null } {
    let out = this.rows.filter((r) => this.filters.every((f) => f(r)));
    for (const { col, asc } of [...this.orderBy].reverse()) {
      out = [...out].sort((a, b) => {
        const x = String(a[col] ?? ''); const y = String(b[col] ?? '');
        return (x < y ? -1 : x > y ? 1 : 0) * (asc ? 1 : -1);
      });
    }
    if (this.cap !== null) out = out.slice(0, this.cap);
    const projected = out.map((r) => project(r, this.columns));
    if (this.mode === 'many') return { data: projected, error: null };
    if (projected.length > 1) throw new Error(`fixtureDb: ${this.table} returned ${projected.length} rows for a single-row read`);
    if (this.mode === 'single' && projected.length === 0) throw new Error(`fixtureDb: ${this.table} returned no row for .single()`);
    return { data: projected[0] ?? null, error: null };
  }

  then<A = { data: unknown; error: null }, B = never>(
    ok?: ((v: { data: unknown; error: null }) => A | PromiseLike<A>) | null,
    fail?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve().then(() => this.run()).then(ok, fail);
  }
}

const REFUSE = (what: string) => () => { throw new Error(`fixtureDb is read-only: ${what} was called`); };

export function fixtureDb(dump: Dump): SupabaseClient {
  const client = {
    from(table: string) {
      if (!(table in dump)) throw new Error(`fixtureDb: table «${table}» is not in the dump`);
      const rows = dump[table] ?? [];
      const q = new Query(table, rows);
      return Object.assign(q, {
        insert: REFUSE(`${table}.insert`), update: REFUSE(`${table}.update`),
        upsert: REFUSE(`${table}.upsert`), delete: REFUSE(`${table}.delete`),
      });
    },
    rpc: REFUSE('rpc'),
  };
  return client as unknown as SupabaseClient;
}
