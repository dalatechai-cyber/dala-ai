import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTenantForEntry } from './resolve.ts';

/** Minimal stub of the Supabase query builder chain this module uses. */
function stubDb(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'select', 'eq', 'limit']) chain[m] = () => chain;
  chain['maybeSingle'] = async () => result;
  return chain as never;
}

test('a known channel resolves to its tenant', async () => {
  const res = await resolveTenantForEntry(
    stubDb({
      data: {
        tenant_id: 't-1', channel_id: 'c-1',
        tenant_channels: { app_slug: 'dala', status: 'active', delivery_mode: 'live' },
      },
      error: null,
    }),
    'facebook_page', '1234',
  );
  assert.equal(res.outcome, 'routed');
  assert.equal(res.outcome === 'routed' && res.tenant.tenantId, 't-1');
});

test('THE ASYMMETRY, half one: an unknown Page is PERMANENT — caller 200s', async () => {
  // Meta is telling us about a Page we do not serve. A non-200 makes Meta retry forever
  // and risks it disabling the subscription — and the Page is the tenant's business.
  const res = await resolveTenantForEntry(stubDb({ data: null, error: null }), 'facebook_page', 'nope');
  assert.equal(res.outcome, 'unknown_channel');
});

test('THE ASYMMETRY, half two: a database error is TRANSIENT — caller 500s', async () => {
  // We do not know whether we serve this Page. A 200 here drops a real customer's message
  // FOREVER, silently, and looks exactly like success. This must never collapse into
  // unknown_channel.
  const res = await resolveTenantForEntry(
    stubDb({ data: null, error: { message: 'connection reset' } }), 'facebook_page', '1234',
  );
  assert.equal(res.outcome, 'registry_unavailable');
});

test('a broken spine is transient, not "unknown" — it is our fault, not Meta\'s', async () => {
  const res = await resolveTenantForEntry(
    stubDb({ data: { tenant_id: 't-1', channel_id: 'c-1' }, error: null }), 'facebook_page', '1234',
  );
  assert.equal(res.outcome, 'registry_unavailable');
});
