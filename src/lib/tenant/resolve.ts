/**
 * Per-entry tenant resolution — the whole product (CLAUDE.md rule 1).
 *
 * ## One POST can carry two tenants
 *
 * Meta batches. A single delivery's `entry[]` may contain events for Page A (tenant 1) and
 * Page B (tenant 2). Resolution is therefore PER ENTRY, never once per request. Anything
 * hoisted out of the loop — a client, a tenant id, a token — is a cross-tenant leak.
 *
 * ## There is no default tenant
 *
 * Not from a request body, not from a header, not from an env var, and not `?? DEFAULT`.
 * If an entry does not resolve, it is unrouted; it is never assigned to somebody.
 *
 * ## The 200/500 asymmetry, which is the subtle part
 *
 * Two failures look similar and must return opposite statuses:
 *
 *   - **Unknown channel** (no active `channel_identity` row): PERMANENT. Meta is telling us
 *     about a Page we do not serve. Return 200. A non-200 here makes Meta retry forever and
 *     risks it disabling the subscription — and the Page asset is the tenant's business.
 *   - **Unreadable registry** (the database errored): TRANSIENT. We do not know whether we
 *     serve this Page. Return 500 so Meta retries. A 200 here drops a real customer's
 *     message FOREVER, silently, and it is indistinguishable from success.
 *
 * Getting these backwards is the failure this function exists to prevent.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export type ResolvedTenant = {
  tenantId: string;
  channelId: string;
  appSlug: string | null;
  status: string;
  deliveryMode: string;
};

export type Resolution =
  | { outcome: 'routed'; tenant: ResolvedTenant }
  /** Permanent: we do not serve this channel. Persist tenant-less, alert, and 200. */
  | { outcome: 'unknown_channel' }
  /** Transient: we could not find out. The whole request must 500. */
  | { outcome: 'registry_unavailable'; detail: string };

/**
 * @param provider    channel_providers.provider, e.g. 'facebook_page'
 * @param externalId  the routing key from entry[].id
 */
export async function resolveTenantForEntry(
  db: SupabaseClient,
  provider: string,
  externalId: string,
): Promise<Resolution> {
  // channel_identity_live_key is UNIQUE on (provider, external_id) WHERE active, so this
  // routes to at most one tenant across all tenants. The join carries tenant_id from the
  // identity row, and the composite FK (tenant_id, channel_id) guarantees the channel row
  // returned belongs to that same tenant — the spine, not a policy, is what enforces that
  // here, because service_role holds BYPASSRLS.
  const { data, error } = await db
    .from('channel_identity')
    .select('tenant_id, channel_id, tenant_channels!inner(app_slug, status, delivery_mode)')
    .eq('provider', provider)
    .eq('external_id', externalId)
    .eq('active', true)
    .limit(1)
    .maybeSingle();

  if (error) {
    // NEVER swallow this into "unknown". A read failure is not an answer.
    return { outcome: 'registry_unavailable', detail: error.message };
  }
  if (data === null) return { outcome: 'unknown_channel' };

  const channel = (data as Record<string, unknown>)['tenant_channels'] as
    | { app_slug: string | null; status: string; delivery_mode: string }
    | undefined;
  if (channel === undefined) {
    // An identity row with no channel row means the spine is broken, which is a platform
    // fault, not an unknown Page. Treat it as transient so it retries and alerts.
    return { outcome: 'registry_unavailable', detail: 'identity row has no channel row' };
  }

  return {
    outcome: 'routed',
    tenant: {
      tenantId: String((data as Record<string, unknown>)['tenant_id']),
      channelId: String((data as Record<string, unknown>)['channel_id']),
      appSlug: channel.app_slug,
      status: channel.status,
      deliveryMode: channel.delivery_mode,
    },
  };
}
