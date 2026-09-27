import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchHeaders, runLaunchJob, LAUNCH_CACHE_SECONDS } from './launchJob.ts';

const CHANNEL = '11111111-2222-4333-8444-555555555555';
const TENANT = '99999999-8888-4777-8666-555555555555';
const SVC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

type Answer = { data: unknown; error: { message: string } | null };
function db(tables: Record<string, Answer>) {
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq']) chain[m] = () => chain;
    chain['maybeSingle'] = async () => tables[table] ?? { data: null, error: null };
    return chain;
  };
  return { from } as never;
}
const channel = (over: Record<string, unknown> = {}): Answer => ({
  data: { tenant_id: TENANT, provider: 'web', status: 'active', delivery_mode: 'live', ...over }, error: null,
});
const tenant: Answer = { data: { live_revision_id: 'rev-1' }, error: null };
const snapshot = (launch: unknown): Answer => ({
  data: { content_hash: 'h', prompt_stable: 'p', prompt_gate: null, allowed_numbers: [], canned_hash: null, launch_states: launch }, error: null,
});

test('DONE-TEST: THE WEBSITE READS THE SAME FROZEN RECORD THE CHAT DOES — the live snapshot, not the switch column', async () => {
  const out = await runLaunchJob(db({
    tenant_channels: channel(), tenants: tenant,
    config_snapshots: snapshot([{ service_id: SVC, name: 'Анар — зөвлөх', state: 'live' }]),
  }), { channelId: CHANNEL });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { services: [{ name: 'Анар — зөвлөх', state: 'live' }], revision: 'rev-1' });
  assert.match(launchHeaders(out)['cache-control'] ?? '', new RegExp(`s-maxage=${LAUNCH_CACHE_SECONDS}`));
  assert.equal(launchHeaders(out)['access-control-allow-origin'], '*');
});

test('a snapshot that recorded nothing is not "nothing is live": the site keeps its own states', async () => {
  const out = await runLaunchJob(db({ tenant_channels: channel(), tenants: tenant, config_snapshots: snapshot(null) }), { channelId: CHANNEL });
  assert.equal(out.status, 503);
  assert.deepEqual(out.body, { error: 'not_recorded' });
});

test('a read that fails is 503 and is never cached; it is never an empty list', async () => {
  const out = await runLaunchJob(db({ tenant_channels: { data: null, error: { message: 'down' } } }), { channelId: CHANNEL });
  assert.equal(out.status, 503);
  assert.equal(launchHeaders(out)['cache-control'], 'no-store');
  const snapDown = await runLaunchJob(db({ tenant_channels: channel(), tenants: { data: null, error: { message: 'down' } } }), { channelId: CHANNEL });
  assert.equal(snapDown.status, 503);
});

test('only an active, live WEBSITE channel answers; anything else is the same 404 as an unknown id', async () => {
  for (const over of [{ provider: 'facebook_page' }, { status: 'suspended' }, { delivery_mode: 'shadow' }]) {
    const out = await runLaunchJob(db({ tenant_channels: channel(over), tenants: tenant, config_snapshots: snapshot([]) }), { channelId: CHANNEL });
    assert.equal(out.status, 404, JSON.stringify(over));
  }
  assert.equal((await runLaunchJob(db({}), { channelId: CHANNEL })).status, 404);
  assert.equal((await runLaunchJob(db({}), { channelId: 'not-a-uuid' })).status, 404);
  assert.equal((await runLaunchJob(db({}), { channelId: null })).status, 404);
});
