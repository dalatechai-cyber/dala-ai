/**
 * `POST /api/web/session` — the website channel's mint.
 *
 * The tenant's own server calls this, holding the tenant's mint secret; a browser never
 * does. **Everything this route decides lives in `@/lib/website/mintJob`**, which takes
 * its effects as an argument and returns `{ status, body }`. What is left here is the
 * binding: which Supabase key, which clock, which secret loader, which human check.
 *
 * The rule that keeps it honest, carried over from `api/workers/reception/route.ts`:
 * **nothing in this file may branch.** A condition here is a condition no test can reach,
 * so it belongs one module down.
 *
 * `POST` and nothing else. Rule 8's caching trap is about GET-only routes, and this one
 * has no GET to cache — but the shared clients are used regardless, because `cache:
 * 'no-store'` is set once there rather than remembered per route.
 */
import { NextResponse } from 'next/server';
import { supabaseWorker } from '@/lib/supabase/clients';
import { required } from '@/lib/env';
import { loadTenantSecret } from '@/lib/secrets/tenantSecret';
import { verifyTurnstile } from '@/lib/website/turnstile';
import { clientIpOf } from '@/lib/website/clientIp';
import { runMintJob, type MintEffects } from '@/lib/website/mintJob';

export const runtime = 'nodejs';

function effects(now: Date): MintEffects {
  const db = supabaseWorker();
  return {
    db,
    now,
    ipSalt: required('CLIENT_IP_SALT'),

    // Per request, never hoisted: a warm lambda is reused across tenants and there must be
    // nothing cached to leak (rule 7).
    loadMintSecret: async ({ tenantId, channelId }) => {
      const secret = await loadTenantSecret(db, { tenantId, channelId, kind: 'web_mint_secret' });
      return secret.ok
        ? { ok: true, secret: secret.secret }
        : { ok: false, retryable: secret.retryable, code: secret.code };
    },

    verifyTurnstile: (token, remoteIp) =>
      verifyTurnstile(token, process.env['TURNSTILE_SECRET_KEY'], remoteIp),

    log: (level, event, fields) => console[level](`[web] ${event}`, fields ?? {}),
  };
}

export async function POST(request: Request): Promise<NextResponse> {
  const result = await runMintJob(effects(new Date()), {
    // Exact bytes. NOT `request.text()` — that decodes to UTF-16 and re-encodes, and one
    // malformed sequence becomes U+FFFD and corrupts the signed bytes.
    rawBody: Buffer.from(await request.arrayBuffer()),
    channelHeader: request.headers.get('x-dala-channel'),
    signatureHeader: request.headers.get('x-dala-signature-256'),
    clientIp: clientIpOf(request.headers),
  });
  return NextResponse.json(result.body, { status: result.status });
}
