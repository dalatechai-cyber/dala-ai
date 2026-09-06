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
import { handleMetaEntry, type MetaEntry } from '@/lib/webhook/entry';
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
  //
  // The decision is `webhook/entry.ts`; this maps its outcomes to a status code and a log
  // line. **Nothing here may branch on anything else** — a branch in a route is a branch
  // no test can reach, and the one that used to live here answered 200 for a message that
  // had never been queued (D-028).
  if (entries.length === 0) {
    // Signed, parsed, and carrying nothing to route. Silent until 2026-09-06, when a real
    // delivery produced no row and no log and there was no way to tell this apart from a
    // delivery that never arrived.
    console.warn('[webhook] no_entries', { provider, app: signature.matchedAppSlug });
  }

  for (const [index, entry] of entries.entries()) {
    const result = await handleMetaEntry(
      { db, enqueue: enqueueReception, log: (level, event, fields) => console[level](`[webhook] ${event}`, fields) },
      {
        provider, entry, index,
        bodyBytes: body.bytes.length,
        matchedAppSlug: signature.matchedAppSlug,
      },
    );

    switch (result.outcome) {
      case 'registry_unavailable':
        // TRANSIENT: we do not know whether we serve this Page. 500 so Meta retries.
        // A 200 here would drop a real customer's message forever, silently.
        console.error('[webhook] registry_unavailable', { provider, detail: result.detail });
        return NextResponse.json({ error: 'webhook.registry_unavailable' }, { status: 500 });
      case 'ledger_unavailable':
        console.error('[webhook] ledger_unavailable', { detail: result.detail });
        return NextResponse.json({ error: 'webhook.ledger_unavailable' }, { status: 500 });
      case 'enqueue_failed':
        console.error('[webhook] enqueue_failed', { detail: result.detail, eventId: result.eventId });
        return NextResponse.json({ error: 'webhook.enqueue_failed' }, { status: 500 });
      case 'no_entry_id':
        console.warn('[webhook] no_entry_id', { provider, idType: result.idType, index });
        break;
      case 'unrouted':
        console.warn('[webhook] unknown_channel', { provider, externalId: result.externalId });
        break;
      case 'app_mismatch':
        console.error('[webhook] app_mismatch', { expected: result.expected, matched: result.matched });
        break;
      case 'already_queued':
        console.info('[webhook] already_queued', { eventId: result.eventId, state: result.state });
        break;
      case 'queued':
        if (result.redelivery) console.warn('[webhook] requeued', { eventId: result.eventId });
        break;
    }
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
