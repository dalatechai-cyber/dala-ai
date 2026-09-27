/**
 * `GET /api/web/launch/<channel>` — which of a tenant's services are live, for its website
 * (D-154).
 *
 * Founder, 2026-09-27: *"When a staff member is ready I flip ITS switch, and the website AND
 * Дали's chat answers change to live together."* The chat reads the switches from the live
 * snapshot (`launch/launch.ts`). So does this: the web channel's live snapshot, never
 * `services.launch_state`. A switch flipped without a publish shows nowhere; a publish shows
 * everywhere at the same pointer move.
 *
 * ## Public, and it says only what the website already says
 *
 * No session, no secret. What it returns — service names and live/pre-registration — is
 * what the tenant's own website prints to every visitor, so a caller that is not a browser
 * learns nothing it could not read off the page. The tenant is derived from the channel id
 * in the path through `tenant_channels`, the registry with a unique key (rule 1), and only a
 * website channel that is active and live answers; anything else is 404, the same answer as
 * an id that does not exist, so the endpoint does not tell a prober which ids are real.
 *
 * ## Fails closed, and the website knows what closed means
 *
 * A read that fails is 503, never an empty list: an empty list would tell the site "no
 * service is live", which is a claim. The site treats every non-200 as "keep the states
 * built into the page" — today's states — so an outage can only ever show a live service as
 * coming soon, never the reverse.
 *
 * Pure apart from `db`: everything the route binds is here, and the route does not branch.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadLiveSnapshot } from '../prompt/publish.ts';
import type { LaunchState } from '../launch/launch.ts';

export const WEB_PROVIDER = 'web';

/**
 * How long a CDN may serve one answer. A flipped switch reaches the website within this,
 * while the chat changes at the pointer move itself; thirty seconds is the gap the founder
 * accepts for "together", and it keeps a traffic spike from becoming a database spike.
 */
export const LAUNCH_CACHE_SECONDS = 30;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu; // ascii-safe: a uuid

export type LaunchBody =
  | { services: { name: string; state: LaunchState }[]; revision: string }
  | { error: 'not_found' | 'unavailable' | 'not_recorded' };

export type LaunchResult = { status: 200 | 404 | 503; body: LaunchBody; cache: boolean };

export async function runLaunchJob(
  db: SupabaseClient,
  input: { channelId: string | null | undefined; log?: (event: string, fields: Record<string, unknown>) => void },
): Promise<LaunchResult> {
  const log = input.log ?? (() => {});
  const channelId = typeof input.channelId === 'string' ? input.channelId.trim().toLowerCase() : '';
  if (!UUID_RE.test(channelId)) return { status: 404, body: { error: 'not_found' }, cache: true };

  const { data: channel, error: channelErr } = await db
    .from('tenant_channels')
    .select('tenant_id, provider, status, delivery_mode')
    .eq('id', channelId)
    .maybeSingle();
  if (channelErr) {
    log('launch_unavailable', { stage: 'tenant_channels', detail: channelErr.message });
    return { status: 503, body: { error: 'unavailable' }, cache: false };
  }
  const row = (channel ?? null) as Record<string, unknown> | null;
  if (row === null || row['provider'] !== WEB_PROVIDER || row['status'] !== 'active' || row['delivery_mode'] !== 'live') {
    return { status: 404, body: { error: 'not_found' }, cache: true };
  }
  const tenantId = String(row['tenant_id']);

  const snap = await loadLiveSnapshot(db, { tenantId, channel: WEB_PROVIDER });
  if (!snap.ok) {
    if (snap.code === 'unavailable') {
      log('launch_unavailable', { stage: 'snapshot', detail: snap.detail });
      return { status: 503, body: { error: 'unavailable' }, cache: false };
    }
    return { status: 404, body: { error: 'not_found' }, cache: true };
  }
  // A snapshot from before 0063 records nothing. That is not "nothing is live": the site
  // keeps its own states, exactly as it does for an outage.
  if (snap.snapshot.launchStates === null) {
    return { status: 503, body: { error: 'not_recorded' }, cache: true };
  }
  return {
    status: 200,
    body: {
      services: snap.snapshot.launchStates
        .filter((r) => r.name !== '')
        .map((r) => ({ name: r.name, state: r.state })),
      revision: snap.snapshot.revisionId,
    },
    cache: true,
  };
}

/** The response headers: public cache for a stable answer, none for a failure. Any origin. */
export function launchHeaders(result: LaunchResult): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, OPTIONS',
    'cache-control': result.cache
      ? `public, max-age=0, s-maxage=${LAUNCH_CACHE_SECONDS}, stale-while-revalidate=${LAUNCH_CACHE_SECONDS * 10}`
      : 'no-store',
  };
}
