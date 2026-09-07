/**
 * The transport, exercised for real: every name the runtime asks PostgREST for must be a
 * name PostgREST can see.
 *
 * ## The bug this exists for
 *
 * On 2026-09-06 `db.rpc('reserve_spend')` asked PostgREST for `public.reserve_spend`. The
 * function lived in `app`. Every reply, for every tenant, refused with `guard_unavailable`
 * from the first message that ever reached the worker — and **the unit tests stubbed
 * `db.rpc` and answered `true`**, so a fully green suite said nothing about it and could
 * not have. Neither could `catalog.sql`, which reads the catalog directly and never asks
 * what a REST profile exposes. Neither could `query-columns.ts`, which checks columns
 * against the applied schema rather than against the thing that serves them.
 *
 * The missing layer was always the same one: **nothing in CI had ever spoken PostgREST**.
 * This does, against a real PostgREST over HTTP, with the real `@supabase/supabase-js`
 * client, on the default `public` profile — which is the profile because `clients.ts`
 * passes no `db: { schema }` option, and that omission is the whole bug.
 *
 * ## Derived from the source, never from a list
 *
 * The names are extracted from `src/` the way `query-columns.ts` extracts columns. A
 * transcribed list would pass while the code called something else — which is the exact
 * shape of the failure it is here to prevent, one level up.
 *
 * ## It ENUMERATES what PostgREST exposes; it does not provoke an error and read the code
 *
 * The first version of this called each RPC with `{}` and treated `PGRST202` as the
 * failure. It reported everything healthy — **including a function I had just dropped.**
 * Two things were wrong with it, and the second is worse than the first:
 *
 *  1. `PGRST202` does not mean "no such function". PostgREST resolves overloads by
 *     argument NAMES, so calling `release_spend` — which exists — with no arguments
 *     returns `PGRST202` too. The signal did not mean what the check assumed.
 *  2. It passed anyway. A check whose positive result is "no specific error came back"
 *     is green when it is broken, which is the exact defect this file exists to catch,
 *     one level up. It was found by dropping a function and watching the check not care.
 *
 * So this asks PostgREST directly. `GET /` returns the OpenAPI description of the profile,
 * filtered to what the presented role may reach, and every name is either in that document
 * or it is not. Reachability by enumeration, with no error code to misread.
 *
 * This checks reachability, not behaviour — `spend.sql` and the unit tests own behaviour.
 *
 * Usage: `node scripts/verify/postgrest.ts` with `PGRST_URL` and `PGRST_JWT` set.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { CHECKED_ROOTS, chainsFromSource } from './querysites.ts';
import http from 'node:http';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';   // guard-ok: scripts/, not src/

const SRC = 'src';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.ts') && !full.endsWith('.test.ts') ? [full] : [];
  });
}

/** Every `db.rpc('name'` and `.from('table'` literal in the runtime source. */
export function namesFromSource(root = process.cwd()): { rpcs: string[]; tables: string[] } {
  const rpcs = new Set<string>();
  const tables = new Set<string>();
  for (const file of walk(path.join(root, SRC))) {
    const text = readFileSync(file, 'utf8');
    // ascii-safe: PostgREST identifiers, ASCII by construction.
    for (const m of text.matchAll(/\.rpc\(\s*'([a-z0-9_]+)'/g)) rpcs.add(String(m[1]));
    for (const m of text.matchAll(/\.from\(\s*'([a-z0-9_]+)'/g)) tables.add(String(m[1]));
  }
  return { rpcs: [...rpcs].sort(), tables: [...tables].sort() };
}

/**
 * Every `.from('t').select('a, b')` pair in the runtime source, with its columns.
 *
 * The reachability half of this file answers "does the NAME resolve". It does not answer
 * "does the column exist", and the gap between those two is a live failure mode rather
 * than a hypothetical: `loadTenantKb` issues thirteen selects and a single wrong column
 * name in any of them makes the whole publish refuse, at publish time, for one tenant —
 * exactly the shape of the bug D-029 catalogued one level up. TypeScript cannot catch it
 * because a PostgREST select list is a string.
 *
 * Embedded resources (`tenant_channels!inner(app_slug, status)`) are parsed rather than
 * skipped, and their columns are checked against the EMBEDDED table. Skipping them would
 * make the check quietly weakest exactly where the query is most complex.
 */
export type SelectUse = {
  file: string;
  table: string;
  columns: string[];
  embeds: { table: string; columns: string[] }[];
};

/** Split a select list on commas that are not inside an embed's parentheses. */
function splitTopLevel(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of list) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter((x) => x !== '');
}

export function parseSelect(file: string, table: string, list: string): SelectUse {
  const columns: string[] = [];
  const embeds: { table: string; columns: string[] }[] = [];
  for (const raw of splitTopLevel(list)) {
    const open = raw.indexOf('(');
    if (open === -1) {
      // `alias:column` renames; the right-hand side is the real column.
      const col = (raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw).trim();
      if (col !== '*' && col !== '') columns.push(col);
      continue;
    }
    // `alias:relation!inner(a, b)` — the relation name is what PostgREST resolves.
    const head = raw.slice(0, open);
    const rel = (head.includes(':') ? head.slice(head.indexOf(':') + 1) : head)
      .split('!')[0]?.trim() ?? '';
    const inner = raw.slice(open + 1, raw.lastIndexOf(')'));
    const parsed = parseSelect(file, rel, inner);
    if (rel !== '') embeds.push({ table: rel, columns: parsed.columns });
  }
  return { file, table, columns, embeds };
}

export function selectsFromSource(root = process.cwd()): SelectUse[] {
  // The chain walker is shared with `query-columns.ts` (`querysites.ts`). It used to be a
  // regex here demanding `.select()` IMMEDIATELY after `.from()`, which silently missed
  // every chain with a filter in between — and missed writes entirely.
  return chainsFromSource(CHECKED_ROOTS.map((r) => path.join(root, r)))
    .filter((c) => c.select !== null)
    .map((c) => parseSelect(path.relative(root, c.file), c.table, c.select ?? ''));
}

/**
 * Every literal `.insert()` / `.update()` / `.upsert()` key set, as columns on its table.
 *
 * The transport check saw no writes at all until 2026-09-07, and a write is where this
 * class of bug bites hardest: a select naming a column that does not exist returns an
 * error the caller can report, while an insert naming one is rejected by PostgREST at the
 * moment a customer is waiting. `worker/reception.ts` carries a hand-written test pinning
 * one insert's `tenant_id` — "a write that every stub accepts and PostgREST rejects" — and
 * that is one site, checked by hand, out of dozens.
 */
export type WriteUse = { file: string; line: number; table: string; verb: string; columns: string[] };

export function writesFromSource(root = process.cwd()): { uses: WriteUse[]; unresolved: string[] } {
  const uses: WriteUse[] = [];
  const unresolved: string[] = [];
  for (const c of chainsFromSource(CHECKED_ROOTS.map((r) => path.join(root, r)))) {
    const file = path.relative(root, c.file);
    for (const w of c.writes) {
      if (w.keys === null) { unresolved.push(`${file}:${c.line} .${w.verb}() keys are not statically resolvable`); continue; }
      if (w.keys.length > 0) uses.push({ file, line: c.line, table: c.table, verb: w.verb, columns: w.keys });
    }
  }
  return { uses, unresolved };
}

export function writeProblems(uses: readonly WriteUse[], known: Map<string, Set<string>>): string[] {
  const problems: string[] = [];
  for (const u of uses) {
    const cols = known.get(u.table);
    // A table absent from `definitions` is already named by the reachability check.
    if (cols === undefined) continue;
    for (const c of u.columns) {
      if (!cols.has(c)) {
        problems.push(`${u.file}:${u.line}: ${u.table}.${c} does not exist on the public profile (.${u.verb}())`);
      }
    }
  }
  return problems;
}

/** `definitions` in PostgREST's Swagger 2.0 document: one entry per exposed relation. */
export function columnsFrom(openApi: unknown): Map<string, Set<string>> {
  const defs = (openApi as { definitions?: Record<string, { properties?: Record<string, unknown> }> })
    ?.definitions ?? {};
  const out = new Map<string, Set<string>>();
  for (const [table, def] of Object.entries(defs)) {
    out.set(table, new Set(Object.keys(def?.properties ?? {})));
  }
  return out;
}

export function selectProblems(uses: readonly SelectUse[], known: Map<string, Set<string>>): string[] {
  const problems: string[] = [];
  const check = (file: string, table: string, columns: readonly string[]) => {
    const cols = known.get(table);
    // A table absent from `definitions` is already reported by the reachability check;
    // reporting every one of its columns too would bury that one line in noise.
    if (cols === undefined) return;
    for (const c of columns) {
      if (!cols.has(c)) problems.push(`${file}: ${table}.${c} does not exist on the public profile`);
    }
  };
  for (const u of uses) {
    check(u.file, u.table, u.columns);
    for (const e of u.embeds) check(u.file, e.table, e.columns);
  }
  return problems;
}

/**
 * What the profile exposes to the role in the JWT.
 *
 * `follow-privileges` is PostgREST's default OpenAPI mode, so this document answers the
 * question that matters — not "does the object exist" but "can the role the runtime uses
 * reach it through the REST profile the runtime asks for".
 */
export function exposedFrom(openApi: unknown): { rpcs: Set<string>; tables: Set<string> } {
  const paths = (openApi as { paths?: Record<string, unknown> })?.paths ?? {};
  const rpcs = new Set<string>();
  const tables = new Set<string>();
  for (const key of Object.keys(paths)) {
    if (key === '/') continue;
    if (key.startsWith('/rpc/')) rpcs.add(key.slice('/rpc/'.length));
    else tables.add(key.slice(1));
  }
  return { rpcs, tables };
}

/**
 * A `service_role` token for the throwaway PostgREST.
 *
 * Minted here rather than passed in, so no token — however worthless — is written down in
 * a workflow file. The secret it signs with is a CI literal that no real system trusts;
 * the only thing that accepts this JWT is a PostgREST that exists for ninety seconds.
 *
 * `role` is the claim that matters: `authenticator` logs in with no privileges and becomes
 * whatever the token says, which is how the runtime's own key works.
 */
function serviceRoleJwt(secret: string): string {
  const enc = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = enc({ alg: 'HS256', typ: 'JWT' });
  const body = enc({ role: 'service_role', iss: 'dala-ci', iat: now, exp: now + 600 });
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

/**
 * Serve `/rest/v1/*` by forwarding to PostgREST's `/*`.
 *
 * In production that mapping is Supabase's API gateway. Here it is the smallest thing that
 * lets the genuine client talk to a genuine PostgREST — headers, query string and body
 * passed through untouched, because every one of them is part of what is being verified.
 */
async function startGatewayProxy(target: string): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    const rest = (req.url ?? '/').replace(/^\/rest\/v1/, '');
    const upstream = new URL(rest === '' ? '/' : rest, target);
    const proxied = http.request(
      upstream,
      { method: req.method, headers: { ...req.headers, host: upstream.host } },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    proxied.on('error', (err) => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: err.message }));
    });
    req.pipe(proxied);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

async function main(): Promise<void> {
  const url = process.env['PGRST_URL'];
  const secret = process.env['PGRST_JWT_SECRET'];
  if (url === undefined || secret === undefined) {
    throw new Error('PGRST_URL and PGRST_JWT_SECRET must be set — see .github/workflows/schema.yml');
  }
  const jwt = serviceRoleJwt(secret);

  const res = await fetch(url, { headers: { Authorization: `Bearer ${jwt}`, apikey: jwt } });
  if (!res.ok) throw new Error(`PostgREST root returned ${res.status}: ${await res.text()}`);
  const openApi: unknown = await res.json();
  const exposed = exposedFrom(openApi);

  const { rpcs, tables } = namesFromSource();
  const selects = selectsFromSource();
  const problems: string[] = [];

  const columns = columnsFrom(openApi);
  problems.push(...selectProblems(selects, columns));

  const writes = writesFromSource();
  problems.push(...writeProblems(writes.uses, columns));
  if (writes.unresolved.length > 0) {
    // Reported, never skipped silently — the same posture `query-columns.ts` takes. A
    // payload built from a variable or a spread cannot be read statically, and a check
    // that quietly covers less than it appears to is the thing both files exist to end.
    process.stdout.write(`  ${writes.unresolved.length} write payload(s) NOT statically resolvable:\n`);
    for (const u of writes.unresolved) process.stdout.write(`    - ${u}\n`);
  }

  for (const name of rpcs) {
    if (!exposed.rpcs.has(name)) {
      problems.push(`rpc ${name}: NOT exposed on the public profile — this is D-029, exactly`);
    }
  }
  for (const table of tables) {
    if (!exposed.tables.has(table)) problems.push(`table ${table}: NOT exposed on the public profile`);
  }

  // One live round trip through the REAL client, so the check cannot pass on a document
  // alone. `@supabase/supabase-js` addresses `${url}/rest/v1/...` because in production
  // that path is Supabase's gateway in front of PostgREST; a bare PostgREST serves at `/`.
  // Sixteen lines of proxy is the honest way to close that gap — the alternative is to
  // stop using the client the runtime actually uses, which is most of the value here.
  const proxy = await startGatewayProxy(url);
  try {
    // Built exactly as `supabase/clients.ts` builds one, and the important part is what is
    // ABSENT: no `db: { schema }`, so the request carries the default `public` profile.
    const db = createClient(proxy.url, jwt, { auth: { persistSession: false, autoRefreshToken: false } });
    const probe = await db.from('tenants').select('id').limit(0);
    if (probe.error !== null) {
      problems.push(`supabase-js could not read tenants over PostgREST: ${probe.error.message}`);
    }
    const rpcProbe = await db.rpc('reserve_spend_all', { p_targets: [], p_surface: 'reception', p_amount_nanousd: 0 });
    // An empty target list is refused by the function itself (`22023`), which is a PASS:
    // reaching the raise means PostgREST found the function and Postgres ran it. Only a
    // resolution failure is a problem, and `PGRST202` is what that looks like.
    if (rpcProbe.error?.code === 'PGRST202') {
      problems.push(`supabase-js could not call reserve_spend_all: ${rpcProbe.error.message}`);
    }
  } finally {
    proxy.close();
  }

  process.stdout.write(
    `  ${rpcs.length} RPC name(s), ${tables.length} table(s), ${selects.length} select list(s) `
    + `and ${writes.uses.length} write payload(s) from ${CHECKED_ROOTS.join(' + ')}, against `
    + `${exposed.rpcs.size} exposed function(s) and ${exposed.tables.size} exposed relation(s)\n`,
  );
  if (problems.length > 0) {
    process.stderr.write(`POSTGREST REACHABILITY FAILED:\n  - ${problems.join('\n  - ')}\n`);
    process.exit(1);
  }
  process.stdout.write('POSTGREST OK (every name and column the runtime selects OR WRITES is exposed on the default profile)\n');
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('postgrest.ts')) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
