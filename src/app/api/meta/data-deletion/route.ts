/**
 * Meta's Data Deletion Request callback (§10.5).
 *
 * A person tells Facebook to delete the data an app holds about them; Facebook POSTs a
 * `signed_request` here. **This endpoint is an App Review deliverable in its own right** —
 * `10-completeness.md` §5 lists it among the things that bounce a submission regardless of
 * which permissions are being asked for, and records that nothing had designed it.
 *
 * ## What it does, and the one thing it deliberately does not do
 *
 * It verifies, records, and hands back a code and a status URL. It does **not** delete
 * anything, and the reason is in `lib/privacy/erasure.ts`: Meta sends an app-scoped id and
 * every id we hold is page-scoped. A `delete from contacts where external_id = <asid>`
 * would match nothing, report success, and leave a person's data in place behind a
 * confirmation code that says otherwise. Recording it and saying so is the honest half we
 * can build today; `docs/STATUS.md` carries what the other half needs.
 *
 * ## Failure returns 500, where the webhook returns 401 — on purpose
 *
 * `webhooks/meta/[app]/route.ts` argues that a configuration failure must not 500, because
 * Meta then retries a customer message forever instead of anybody noticing. The opposite
 * is true here. A dropped deletion request is a legal obligation we never learn we
 * incurred, and there is no redelivery after a 200. So anything short of "recorded" is a
 * 5xx and Meta retries. The asymmetry is the point, not an inconsistency.
 */
import { NextResponse } from 'next/server';
import { verifySignedRequest } from '@/lib/meta/signedRequest';
import { recordErasureRequest } from '@/lib/privacy/erasure';
import { supabasePrivacy } from '@/lib/supabase/clients';
import { raiseAlert } from '@/lib/alerts/alert';
import { required } from '@/lib/env';

// node:crypto is unavailable on the edge runtime.
export const runtime = 'nodejs';
export const maxDuration = 15;

/** Bounded: a signed_request is a few hundred bytes. */
const MAX_BODY_BYTES = 16 * 1024;

/**
 * Meta posts `application/x-www-form-urlencoded`. JSON is accepted too, because a form
 * encoding is a convention rather than a guarantee and losing a deletion request over a
 * content type would be a bad way to find that out.
 */
function readSignedRequest(raw: string, contentType: string | null): string | null {
  const value = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
  if (contentType !== null && contentType.includes('application/json')) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return value(parsed['signed_request']);
    } catch {
      return null;
    }
  }
  return value(new URLSearchParams(raw).get('signed_request'));
}

/**
 * The URL Meta shows the person.
 *
 * From configuration, never from the request's own Host header. This value is echoed to a
 * third party and then to a member of the public; deriving it from an attacker-controlled
 * header is how a status URL becomes somebody else's page.
 */
function statusUrlFor(code: string): string {
  const url = new URL('/data-deletion/status', required('DALA_PUBLIC_URL'));
  url.searchParams.set('code', code);
  return url.toString();
}

export async function POST(request: Request): Promise<NextResponse> {
  const buf = Buffer.from(await request.arrayBuffer());
  if (buf.byteLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'privacy.body_too_large' }, { status: 413 });
  }

  const signedRequest = readSignedRequest(buf.toString('utf8'), request.headers.get('content-type'));
  if (signedRequest === null) {
    return NextResponse.json({ error: 'privacy.signed_request_missing' }, { status: 400 });
  }

  let verified;
  try {
    verified = verifySignedRequest(signedRequest);
  } catch (err) {
    // META_APP_SECRETS unset or unusable: we could not check, which must never be recorded
    // as "they failed". 500 so Meta retries once this is fixed.
    console.error('[privacy] startup.config_invalid', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: 'privacy.config_invalid' }, { status: 500 });
  }

  if (!verified.ok) {
    // Never the payload and never the signature — only which check refused.
    console.warn('[privacy] signed_request refused', { refusal: verified.refusal });
    return NextResponse.json({ error: `privacy.${verified.refusal}` }, { status: 400 });
  }

  const db = supabasePrivacy();
  const recorded = await recordErasureRequest(db, {
    provider: 'facebook',
    externalId: verified.payload.userId,
    // The namespace, recorded as what it actually is. See lib/privacy/erasure.ts.
    idKind: 'asid',
    appSlug: verified.payload.matchedAppSlug,
    issuedAt: verified.payload.issuedAt,
  });

  if (!recorded.ok) {
    console.error('[privacy] erasure_request_not_recorded', { detail: recorded.detail });
    return NextResponse.json({ error: 'privacy.not_recorded' }, { status: 500 });
  }

  if (recorded.created) {
    // One alert per day, not one per request: a request arriving is not itself an
    // incident, but a day passing with requests nobody has acted on is. The period is in
    // the dedup key for the same reason the spend alerts put it there.
    const day = new Date().toISOString().slice(0, 10);
    const alerted = await raiseAlert(db, {
      tenantId: null,
      severity: 'warn',
      kind: 'privacy.erasure_requested',
      dedupKey: `privacy.erasure_requested:${day}`,
      body:
        `Data deletion request(s) received today (${day}). They are RECORDED, not fulfilled: ` +
        `Meta sends an app-scoped id and we store page-scoped ids. ` +
        `See docs/STATUS.md — resolving them needs the ID Matching API.`,
    });
    // An alert that did not send must not fail the callback: the row is the obligation,
    // the Telegram message is only how somebody hears about it.
    if (alerted.outcome === 'failed') {
      console.error('[privacy] erasure_alert_failed', { detail: alerted.detail });
    }
  }

  let url: string;
  try {
    url = statusUrlFor(recorded.code);
  } catch (err) {
    console.error('[privacy] public_url_unset', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'privacy.config_invalid' }, { status: 500 });
  }

  // Standard JSON, with quoted keys.
  //
  // Several widely-copied implementations emit `{ url: '…', confirmation_code: '…' }` —
  // a JavaScript object literal, not JSON — because Meta's own documentation illustrates
  // the response with a JS literal and people transcribe it verbatim. Some of them assert
  // that proper JSON "fails". It does not; it is the only thing a JSON parser accepts.
  // If Meta ever rejects this response, that claim is the first thing to re-test — but do
  // not pre-emptively ship invalid JSON on the strength of a superstition.
  return NextResponse.json({ url, confirmation_code: recorded.code }, { status: 200 });
}
