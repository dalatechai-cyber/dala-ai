/**
 * Compile one tenant's stable prefix against a real PostgreSQL, through the REAL compiler.
 *
 * ## Why this exists
 *
 * `compileStablePrefix` had no caller outside its own tests. So the question "does this
 * tenant's configuration actually compile, and what comes out?" could only be answered by
 * publishing — which is the wrong moment to find out, and needs a credential. Every part
 * of the answer was reachable offline and nothing reached for it.
 *
 * Run against the scratch cluster after the provisioning files, it prints the artefact a
 * publish would freeze: the character count, the `content_hash` that becomes the
 * prompt-cache key, `allowed_numbers`, and the section order. In CI it is a standing check
 * that the fixture tenant still compiles at all.
 *
 * ## What it proves, and the one thing it does not
 *
 * It runs the real `loadPromptSections`, the real `loadTenantKb`, the real
 * `renderTenantSections` and the real `renderStablePrefix` over real rows — so a column
 * renamed, a section that stops rendering, or an ordering that becomes ambiguous all fail
 * here.
 *
 * It reaches the database over `psql` rather than PostgREST, because this environment has
 * neither a PostgREST binary nor a container runtime. **That is a real gap and it is the
 * gap `scripts/verify/postgrest.ts` covers**: names and columns resolving over the actual
 * transport. Do not read a pass here as covering the wire — read the two together.
 *
 * The adapter below is deliberately narrow. Every shape it does not understand THROWS
 * rather than returning an empty set: a fake that answers plausibly instead of admitting
 * it cannot see is the exact failure D-020 names, and an empty result here would look like
 * a tenant with no rows — which is a state the compiler is built to tolerate, so nothing
 * downstream would notice.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import type { SupabaseClient } from '@supabase/supabase-js';
import { compileStablePrefix } from '../../src/lib/prompt/sections.ts';

const DB = process.env['PGDATABASE'] ?? 'dala_validate';
const SLUG = process.argv[2] ?? 'matrix-eco-salon';

const psql = (sql: string): string =>
  execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-tAq', '-d', DB, '-c', sql], { encoding: 'utf8' }).trim();

/**
 * Column types PostgREST serialises as STRINGS and `json_agg` would serialise as numbers
 * or bare literals. Casting them keeps this adapter's rows the same shape the runtime
 * sees — `numeric(12,2)` arriving as `33000.00` the string is what `formatMoney` is
 * written against, and a JSON number here would pass its `Number()` and diverge silently
 * the first time a price had trailing zeroes.
 */
const CAST_TO_TEXT = new Set(['numeric', 'date', 'time without time zone', 'timestamp with time zone', 'timestamp without time zone', 'uuid', 'bigint', 'smallint']);

const typeCache = new Map<string, Map<string, string>>();
function columnTypes(table: string): Map<string, string> {
  const held = typeCache.get(table);
  if (held !== undefined) return held;
  const raw = psql(
    `select coalesce(json_agg(json_build_object('c', column_name, 't', data_type)), '[]')
       from information_schema.columns where table_schema='public' and table_name='${table}';`,
  );
  const m = new Map<string, string>();
  for (const r of JSON.parse(raw) as { c: string; t: string }[]) m.set(r.c, r.t);
  typeCache.set(table, m);
  return m;
}

function selectList(table: string, cols: string): string {
  const types = columnTypes(table);
  return cols.split(',').map((c) => c.trim()).filter((c) => c !== '').map((c) => {
    const t = types.get(c);
    if (t === undefined) throw new Error(`compile-tenant: ${table} has no column ${c}`);
    // `smallint`/`bigint` are cast for shape fidelity but read back through `num()`, which
    // accepts either; the cast costs nothing and removes a difference nobody would notice.
    return CAST_TO_TEXT.has(t) ? `${c}::text as ${c}` : c;
  }).join(', ');
}

const lit = (v: unknown): string => {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  const s = String(v);
  // Only ever a uuid or a literal this file wrote. Anything else is a bug, not an input.
  if (!/^[0-9a-zA-Z_-]*$/.test(s)) throw new Error(`compile-tenant: refusing to interpolate ${JSON.stringify(s)}`);
  return `'${s}'`;
};

type Row = Record<string, unknown>;

class Query implements PromiseLike<{ data: Row[] | Row | null; error: null }> {
  private readonly wheres: string[] = [];
  private single = false;
  private readonly table: string;
  private readonly cols: string;
  // Plain fields, not parameter properties: node's strip-only TypeScript cannot compile
  // those, and every script here runs under `node` directly rather than through a build.
  constructor(table: string, cols: string) { this.table = table; this.cols = cols; }

  eq(col: string, val: unknown): this { this.wheres.push(`${col} = ${lit(val)}`); return this; }
  /** Ordering is re-done in JavaScript by code point (D-026), so this is a no-op by design. */
  order(_col: string): this { return this; }
  maybeSingle(): this { this.single = true; return this; }

  or(expr: string): this {
    // The one call site: platform blocks with no tenant, plus this tenant's own blocks.
    const m = /^and\(scope\.eq\.platform,tenant_id\.is\.null\),and\(scope\.eq\.tenant,tenant_id\.eq\.([0-9a-f-]+)\)$/.exec(expr);
    if (m === null) throw new Error(`compile-tenant: unsupported .or() filter: ${expr}`);
    this.wheres.push(`((scope = 'platform' and tenant_id is null) or (scope = 'tenant' and tenant_id = ${lit(m[1] ?? '')}))`);
    return this;
  }

  then<R1, R2 = never>(
    ok?: ((v: { data: Row[] | Row | null; error: null }) => R1 | PromiseLike<R1>) | null,
    err?: ((r: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return Promise.resolve().then(() => {
      const where = this.wheres.length === 0 ? '' : ` where ${this.wheres.join(' and ')}`;
      const sql = `select coalesce(json_agg(to_jsonb(x)), '[]'::json) from (select ${selectList(this.table, this.cols)} from ${this.table}${where}) x;`;
      const rows = JSON.parse(psql(sql)) as Row[];
      if (this.single && rows.length > 1) throw new Error(`compile-tenant: maybeSingle got ${rows.length} rows from ${this.table}`);
      return { data: this.single ? (rows[0] ?? null) : rows, error: null };
    }).then(ok, err);
  }
}

const db = { from: (table: string) => ({ select: (cols: string) => new Query(table, cols) }) } as unknown as SupabaseClient;

const tenantId = psql(`select id from tenants where slug = ${lit(SLUG)};`);
if (tenantId === '') { console.error(`no tenant with slug ${SLUG}`); process.exit(1); }

const out = await compileStablePrefix(db, { tenantId, approvedAt: '2026-09-07T00:00:00Z' });
if (!out.ok) {
  console.error(`COMPILE REFUSED (${out.code}): ${'detail' in out ? out.detail : JSON.stringify(out.refusal)}`);
  process.exit(1);
}

const { rendered } = out;
console.log(`tenant        ${SLUG}  (${tenantId})`);
console.log(`sections      ${out.sectionCount}`);
console.log(`prompt chars  ${rendered.promptChars}`);
console.log(`content_hash  ${rendered.contentHash}`);
console.log(`allowed_numbers  [${rendered.allowedNumbers.join(', ')}]`);
console.log(`order         ${rendered.order.join(' → ')}`);
if (out.unconfirmed.faqsExcluded.length > 0) console.log(`EXCLUDED faqs ${out.unconfirmed.faqsExcluded.join(', ')}`);
if (out.unconfirmed.refusalTopicsUnconfirmed.length > 0) console.log(`UNCONFIRMED topics ${out.unconfirmed.refusalTopicsUnconfirmed.join(', ')}`);

if (process.env['PRINT_PREFIX'] === '1') {
  console.log('\n----- compiled prefix -----\n');
  console.log(rendered.promptStable);
}

/**
 * `--emit-publish-sql <path>`: write the publish as SQL instead of performing it.
 *
 * This environment has no Supabase service-role key and must never ask for one, so the
 * real client path — `compileAndPublish` → `publishRevision` — cannot run against the
 * project from here. The alternative is to emit exactly what `publishRevision` does, in
 * its order, and apply that.
 *
 * **A second implementation of publish is a bad thing, and this is why it is acceptable
 * anyway:** every invariant `publishRevision` relies on is enforced by the DATABASE, not
 * by the function — the composite FK `(tenants.id, live_revision_id) → config_revisions
 * (tenant_id, id)`, `published_has_a_time`, and the absence of any update path on
 * `config_snapshots`. And the one thing SQL generation could plausibly corrupt, the
 * 12,000-character Mongolian prefix, is checked end to end: `content_hash` is
 * `sha256(prompt_stable)`, so re-hashing the STORED text against the compiled hash proves
 * byte identity. A transcription error cannot survive that check.
 *
 * The step order is `publishRevision`'s and must stay so: insert the snapshot, mark the
 * revision published with a CAS on `draft`, supersede the outgoing one, and only then move
 * the pointer. Moving the pointer first opens a window where `live_revision_id` names a
 * revision with no snapshot, and every reply in that window 503s.
 */
const emitAt = process.argv.indexOf('--emit-publish-sql');
if (emitAt !== -1) {
  const path = process.argv[emitAt + 1];
  if (path === undefined) { console.error('--emit-publish-sql needs a path'); process.exit(1); }
  const q = (v: string) => `$body$${v}$body$`;
  const nums = rendered.allowedNumbers.map((n) => q(n)).join(', ');
  const sql = `-- GENERATED by scripts/verify/compile-tenant.ts. Do not edit.
-- Mirrors publishRevision() step for step; see that function before changing anything here.
begin;

insert into config_revisions (tenant_id, seq, status, created_by)
select t.id, coalesce((select max(r.seq) from config_revisions r where r.tenant_id = t.id), 0) + 1, 'draft', null
from tenants t where t.slug = ${q(SLUG)}
  and not exists (select 1 from config_revisions r where r.tenant_id = t.id and r.status = 'draft');

-- 1. THE INSERT. Immutable, one row per channel.
insert into config_snapshots
  (tenant_id, revision_id, channel, content_hash, prompt_stable, prompt_volatile,
   prompt_chars, allowed_numbers, compiled_at, compiled_by)
select r.tenant_id, r.id, tc.provider, ${q(rendered.contentHash)}, ${q(rendered.promptStable)}, '',
       -- compiled_by is a uuid FK to platform_admins, not a label. That table is empty,
       -- so it is null, which is the value publishRevision passes when nobody is named.
       ${rendered.promptChars}, array[${nums}]::text[], now(), null
from config_revisions r
join tenants t on t.id = r.tenant_id
-- THE CHANNEL IS THE TENANT'S OWN, never a literal. Written 'messenger' by hand once, and
-- worker/reception.ts asks loadLiveSnapshot for 'facebook_page' — so the snapshot existed,
-- looked published, and would have answered no_snapshot for every reply. config_snapshots
-- is append-only by trigger, so that row could not be corrected, only out-appended.
join tenant_channels tc on tc.tenant_id = t.id
where t.slug = ${q(SLUG)} and r.status = 'draft'
  and not exists (select 1 from config_snapshots s where s.revision_id = r.id and s.channel = tc.provider);

-- 2. Mark it published. CAS on draft.
update config_revisions r set status = 'published', published_at = now()
from tenants t where t.id = r.tenant_id and t.slug = ${q(SLUG)} and r.status = 'draft';

-- 3. Supersede any other published revision BEFORE the pointer moves.
update config_revisions r set status = 'superseded'
from tenants t
where t.id = r.tenant_id and t.slug = ${q(SLUG)} and r.status = 'published'
  and r.id <> (select r2.id from config_revisions r2 where r2.tenant_id = t.id
                order by r2.published_at desc nulls last limit 1);

-- 4. THE POINTER MOVE.
update tenants t set live_revision_id = (
  select r.id from config_revisions r where r.tenant_id = t.id and r.status = 'published'
   order by r.published_at desc limit 1)
where t.slug = ${q(SLUG)};

-- The check that makes generating this SQL safe: the STORED prefix must re-hash to the
-- hash the compiler produced. One byte of transcription damage fails the transaction.
do $$
declare v_bad int;
begin
  select count(*) into v_bad from config_snapshots s join tenants t on t.id = s.tenant_id
   where t.slug = ${q(SLUG)}
     and encode(sha256(convert_to(s.prompt_stable, 'UTF8')), 'hex') <> s.content_hash;
  if v_bad > 0 then
    raise exception 'publish: % snapshot(s) whose stored prefix does not match their content_hash', v_bad;
  end if;
  if not exists (
    select 1 from tenants t
      join tenant_channels tc on tc.tenant_id = t.id
      join config_snapshots s on s.revision_id = t.live_revision_id and s.channel = tc.provider
     where t.slug = ${q(SLUG)} and s.content_hash = ${q(rendered.contentHash)}) then
    raise exception 'publish: the live revision has no snapshot on the tenant''s own channel';
  end if;
end $$;

commit;
`;
  writeFileSync(path, sql);
  console.log(`\npublish SQL written to ${path} (${sql.length} chars)`);
}

console.log('\nCOMPILE OK');
