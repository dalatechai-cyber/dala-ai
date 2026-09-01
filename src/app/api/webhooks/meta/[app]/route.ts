/**
 * The Meta webhook. GET is the verify handshake; POST is delivery.
 *
 * Both live in one file because Meta points a single callback URL at both. `[app]` is a
 * SLUG, not a secret — it selects which app secret and verify token to expect, and a wrong
 * slug simply fails the HMAC.
 *
 * Order is the design. Nothing that costs money or touches a tenant happens before the
 * signature verifies, and nothing slow happens before the 200.
 */
import { NextResponse } from 'next/server';
import { readRawBody } from '@/lib/meta/rawBody';
import { verifyMetaSignature, verifyHandshakeToken } from '@/lib/meta/signature';
import { supabaseWebhook } from '@/lib/supabase/clients';
import { resolveTenantForEntry } from '@/lib/tenant/resolve';
import { claimWebhookEvent, markEventState } from '@/lib/webhook/events';
import { enqueueReception } from '@/lib/queue/qstash';

// node:crypto.timingSafeEqual and the Upstash SDKs are unavailable on the edge runtime.
export const runtime = 'nodejs';
// Explicit rather than inherited: this route does no model work before the 200, so it has
// no business running long. The ancestor never set one.
export const maxDuration = 15;

/**
 * Meta `object` → the provider key in `channel_providers`.
 *
 * A TABLE, not an equality guard. The ancestor's `if (body.object !== 'page') return 200`
 * makes an Instagram rollout a SILENT no-op: the endpoint ACKs perfectly and answers
 * nobody. An unrecognised object is a Meta product we have not built yet, not an attack.
 */
const OBJECT_PROVIDERS: Record<string, string> = {
  page: 'facebook_page',
  instagram: 'instagram',
};

type MetaEntry = { id?: unknown; messaging?: unknown[] };

export async function GET(
  request: Request,
  context: { params: Promise<{ app: string }> },
): Promise<NextResponse> {
  const { app } = await context.params;
  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  if (mode !== 'subscribe' || !verifyHandshakeToken(app, token)) {
    return NextResponse.json({ error: 'webhook.verify_failed' }, { status: 403 });
  }
  // Meta requires the challenge echoed as bare text.
  return new NextResponse(challenge ?? '', { status: 200, headers: { 'content-type': 'text/plain' } }) as NextResponse;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ app: string }> },
): Promise<NextResponse> {
  const { app } = await context.params;

  // --- 1. Raw bytes, bounded -------------------------------------------------
  const body = await readRawBody(request);
  if (!body.ok) return NextResponse.json({ error: body.code }, { status: body.status });

  // --- 2. Signature, before anything else ------------------------------------
  let signature;
  try {
    signature = verifyMetaSignature(body.bytes, request.headers.get('x-hub-signature-256'), app);
  } catch (err) {
    // META_APP_SECRETS unset or unparsable. 401 and page the founder — never 200, never
    // skip, and never 500 (a 500 gets retried forever instead of noticed).
    console.error('[webhook] startup.config_invalid', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'startup.config_invalid' }, { status: 401 });
  }
  if (!signature.ok) {
    // Log the body's digest, never the body.
    console.warn('[webhook] signature refused', { reason: signature.reason, app, matched_app_slug: 'none' });
    return NextResponse.json({ error: `webhook.${signature.reason}` }, { status: 401 });
  }

  // --- 3. Parse only now, and dispatch on `object` ---------------------------
  let payload: { object?: unknown; entry?: unknown };
  try {
    payload = JSON.parse(body.bytes.toString('utf8')) as typeof payload;
  } catch {
    return NextResponse.json({ error: 'webhook.body_not_json' }, { status: 400 });
  }

  const provider = typeof payload.object === 'string' ? OBJECT_PROVIDERS[payload.object] : undefined;
  if (provider === undefined) {
    console.warn('[webhook] unknown_object', { object: payload.object });
    return NextResponse.json({ ok: true, ignored: 'unknown_object' }, { status: 200 });
  }

  const entries: MetaEntry[] = Array.isArray(payload.entry) ? (payload.entry as MetaEntry[]) : [];
  const db = supabaseWebhook();

  // --- 4. PER ENTRY. One POST can carry two tenants. -------------------------
  for (const [index, entry] of entries.entries()) {
    const externalId = typeof entry.id === 'string' ? entry.id : null;
    if (externalId === null) continue;

    const resolution = await resolveTenantForEntry(db, provider, externalId);

    // TRANSIENT: we do not know whether we serve this Page. 500 so Meta retries.
    // A 200 here would drop a real customer's message forever, silently.
    if (resolution.outcome === 'registry_unavailable') {
      console.error('[webhook] registry_unavailable', { provider, detail: resolution.detail });
      return NextResponse.json({ error: 'webhook.registry_unavailable' }, { status: 500 });
    }

    const dedupKey = `${externalId}:${index}:${body.bytes.length}:${signature.matchedAppSlug}`;

    // PERMANENT: a Page we do not serve. Persist tenant-less so it is diagnosable, then 200.
    if (resolution.outcome === 'unknown_channel') {
      console.warn('[webhook] unknown_channel', { provider, externalId });
      await claimWebhookEvent(db, {
        provider, dedupKey, routing: 'unrouted', tenantId: null, channelId: null,
        entryId: externalId, rawPayload: entry, leaseSeconds: 60,
      });
      continue;
    }

    const { tenant } = resolution;

    // The app-vs-identity cross-check. During cutover a Page is legitimately subscribed to
    // two apps; without this, a leaked second app secret authenticates events for a Page we
    // believe is elsewhere and nothing notices. It costs one string comparison.
    if (tenant.appSlug !== null && tenant.appSlug !== signature.matchedAppSlug) {
      console.error('[webhook] app_mismatch', {
        expected: tenant.appSlug, matched: signature.matchedAppSlug, tenantId: tenant.tenantId,
      });
      continue;
    }

    const claim = await claimWebhookEvent(db, {
      provider, dedupKey, routing: 'routed', tenantId: tenant.tenantId,
      channelId: tenant.channelId, entryId: externalId, rawPayload: entry, leaseSeconds: 60,
    });

    if (claim.outcome === 'unavailable') {
      console.error('[webhook] ledger_unavailable', { detail: claim.detail });
      return NextResponse.json({ error: 'webhook.ledger_unavailable' }, { status: 500 });
    }
    if (claim.outcome === 'duplicate') continue; // Meta redelivery. Already ours.

    const enqueued = await enqueueReception({
      provider, dedupKey, eventId: claim.eventId,
      tenantId: tenant.tenantId, channelId: tenant.channelId,
    });
    await markEventState(db, claim.eventId, enqueued.ok ? 'pending_enqueue' : 'failed');
    if (!enqueued.ok) {
      console.error('[webhook] enqueue_failed', { detail: enqueued.detail });
      return NextResponse.json({ error: 'webhook.enqueue_failed' }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
