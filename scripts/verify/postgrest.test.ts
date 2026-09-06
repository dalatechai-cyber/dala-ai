import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  columnsFrom, exposedFrom, namesFromSource, parseSelect, selectProblems, selectsFromSource,
} from './postgrest.ts';

test('the names come from the source, never from a list', () => {
  // A transcribed list would pass while the code called something else — the exact shape
  // of the failure this check exists to prevent, one level up.
  const { rpcs, tables } = namesFromSource();
  assert.ok(rpcs.includes('reserve_spend_all'), `rpcs: ${rpcs.join(', ')}`);
  assert.ok(rpcs.includes('release_spend'));
  assert.ok(rpcs.includes('settle_spend_all'));
  assert.ok(tables.includes('outbound_messages') && tables.includes('config_snapshots'));
  // Nothing invented: every name is a plain identifier, so a stray match would show up.
  for (const name of [...rpcs, ...tables]) assert.match(name, /^[a-z][a-z0-9_]*$/); // ascii-safe: SQL identifiers
});

test('DONE-TEST: EXPOSURE IS ENUMERATED, not inferred from an error code', () => {
  // The first version of this check called each RPC with `{}` and read `PGRST202` as "not
  // found". It reported everything healthy INCLUDING A FUNCTION THAT HAD JUST BEEN
  // DROPPED, because PostgREST resolves overloads by argument name and returns PGRST202
  // for an existing function called with the wrong ones. A check whose pass condition is
  // "no specific error came back" is green when it is broken.
  const doc = {
    paths: {
      '/': {},
      '/rpc/reserve_spend_all': {},
      '/rpc/release_spend': {},
      '/tenants': {},
      '/outbound_messages': {},
    },
  };
  const { rpcs, tables } = exposedFrom(doc);
  assert.deepEqual([...rpcs].sort(), ['release_spend', 'reserve_spend_all']);
  assert.deepEqual([...tables].sort(), ['outbound_messages', 'tenants']);
});

test('an empty or malformed document exposes nothing, rather than throwing', () => {
  // A PostgREST that answered with something unexpected must fail the check, not crash it
  // — the difference between "the transport is broken" and "the script is broken" should
  // not be a stack trace.
  assert.equal(exposedFrom({}).rpcs.size, 0);
  assert.equal(exposedFrom(null).tables.size, 0);
  assert.equal(exposedFrom('nonsense').tables.size, 0);
});

// ---------------------------------------------------------------------------
// The column half: a name that resolves is not a query that runs
// ---------------------------------------------------------------------------

test('a select list is parsed into columns, with aliases resolved to the real column', () => {
  const u = parseSelect('f.ts', 'tenants', 'id, label:display_name, vertical');
  assert.deepEqual(u.columns, ['id', 'display_name', 'vertical']);
  assert.deepEqual(u.embeds, []);
});

test('AN EMBED IS CHECKED AGAINST THE EMBEDDED TABLE, not the outer one', () => {
  // Skipping embeds would leave the check weakest exactly where the query is hardest to
  // read — and `channel_identity` has no `app_slug`, so attributing the inner columns to
  // the outer table would report three failures that are not real.
  const u = parseSelect('f.ts', 'channel_identity',
    'tenant_id, channel_id, tenant_channels!inner(app_slug, status, delivery_mode)');
  assert.deepEqual(u.columns, ['tenant_id', 'channel_id']);
  assert.deepEqual(u.embeds, [{ table: 'tenant_channels', columns: ['app_slug', 'status', 'delivery_mode'] }]);
});

test('a star selects everything and asserts nothing', () => {
  assert.deepEqual(parseSelect('f.ts', 'tenants', '*').columns, []);
});

test('DONE-TEST: A COLUMN THAT DOES NOT EXIST IS NAMED, outer and embedded alike', () => {
  // Proven against a real PostgREST three ways before being trusted: dropping the column
  // `0019` adds, mistyping a plain column, and mistyping a column inside an embed. The
  // first run of the first mutation said OK — and that was a STALE SCHEMA CACHE in a
  // PostgREST left running from the previous attempt, not a passing check. The workflow
  // starts PostgREST after the migrations for exactly that reason.
  const known = new Map([
    ['staff_members', new Set(['id', 'name', 'group_name', 'tier'])],
    ['tenant_channels', new Set(['app_slug', 'status'])],
  ]);
  const problems = selectProblems([
    parseSelect('a.ts', 'staff_members', 'name, short_name, group_name'),
    parseSelect('b.ts', 'channel_identity', 'tenant_channels!inner(app_slug, delivery_mode)'),
  ], known);
  assert.deepEqual(problems, [
    'a.ts: staff_members.short_name does not exist on the public profile',
    'b.ts: tenant_channels.delivery_mode does not exist on the public profile',
  ]);
});

test('a table missing from the document is left to the reachability check', () => {
  // Otherwise one unexposed relation becomes one line per column it is selected with, and
  // the line that says WHY — the table is not on the profile at all — is buried in them.
  assert.deepEqual(selectProblems([parseSelect('a.ts', 'nope', 'x, y, z')], new Map()), []);
});

test('columnsFrom reads the Swagger definitions, and survives a document without them', () => {
  const cols = columnsFrom({ definitions: { tenants: { properties: { id: {}, vertical: {} } } } });
  assert.deepEqual([...(cols.get('tenants') ?? [])].sort(), ['id', 'vertical']);
  assert.equal(columnsFrom({}).size, 0);
  assert.equal(columnsFrom(null).size, 0);
});

test('the select lists come from the source too, chained across lines', () => {
  // `resolve.ts` puts `.from()` and `.select()` on separate lines. A regex that required
  // them adjacent would silently skip the only two embedded queries in the codebase.
  const uses = selectsFromSource();
  const resolve = uses.find((u) => u.file.endsWith('tenant/resolve.ts'));
  assert.ok(resolve !== undefined, `no select found in tenant/resolve.ts: ${uses.map((u) => u.file).join(', ')}`);
  assert.deepEqual(resolve.embeds.map((e) => e.table), ['tenant_channels']);
  const staff = uses.find((u) => u.table === 'staff_members');
  assert.ok(staff?.columns.includes('short_name'), `staff select: ${JSON.stringify(staff)}`);
});
