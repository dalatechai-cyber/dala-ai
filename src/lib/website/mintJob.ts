/**
 * `POST /api/web/session` — the mint, as a testable job.
 *
 * `mint.ts` holds the cryptography and the reasoning about WHY the browser is never asked
 * who it is. This is the orchestration: which reads happen, in what order, and what the
 * caller is told. It takes its effects as an argument for the same reason
 * `worker/reception.ts` does — a route handler is awkward to test for uninteresting
 * reasons, and the reasons win, leaving a dozen branches about another tenant's money
 * unchecked.
 *
 * ## This endpoint is SERVER-to-server, and that is why it has no CORS
 *
 * The tenant's own backend calls it, holding the tenant's mint secret. A browser cannot
 * call it, must not call it, and is never given anything it could call it with. So there
 * is deliberately no `Access-Control-Allow-Origin` here: adding one would advertise a
 * surface the design says browsers have no business on, and `Matrix-Chatbot/lib/cors.js`
 * is emphatic that CORS is not an authorization gate in either direction.
 *
 * `POST /api/web/message` is the browser-facing half and does carry CORS.
 *
 * ## The order, and why each step sits where it does
 *
 *  1. **Shape-check the channel header.** A malformed id is refused without a query.
 *  2. **Resolve the channel.** One indexed read, and the only work an unauthenticated
 *     caller can force before the limiter applies — unavoidable, because the rate bucket
 *     is tenant-scoped and there is no tenant until this read. Stated rather than hidden.
 *  3. **Rate-limit.** Before the secret is decrypted, which is the expensive step: a KEK
 *     unwrap plus an AES open, per request.
 *  4. **Load the mint secret** and **verify the HMAC over the raw bytes.** This is the
 *     step that derives the tenant. Everything above only narrowed which secret to try.
 *  5. **Turnstile**, behind the HMAC — see `turnstile.ts`, which says at length that
 *     inverting this ordering makes a cost-multiplier into the authorization.
 *  6. **Insert the session.**
 *
 * ## One refusal, several diagnoses
 *
 * Every authorization failure answers `mint_unauthorised`. An unknown channel, a channel
 * belonging to another provider, a suspended channel, an absent secret and a wrong
 * signature are one answer over the wire and five different lines in the log. Otherwise
 * this endpoint enumerates which channel ids exist, unauthenticated, at whatever rate the
 * limiter allows.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  verifyMintSignature,
  newSessionToken,
  hashClientIp,
  type MintRefusal,
  type MintDiagnosis,
} from './mint.ts';
import { consumeRate } from './ratelimit.ts';
import type { TurnstileOutcome } from './turnstile.ts';

/**
 * How long a minted session lives.
 *
 * A platform constant rather than a column, deliberately: `turn_cap` bounds what a session
 * may SPEND and is therefore the tenant's to choose, while this bounds how long a leaked
 * token is worth stealing, which is ours. Two hours is a real conversation with real gaps
 * in it, and short enough that a token scraped from a browser's network tab is worthless
 * by the time anybody reads it.
 */
export const WEB_SESSION_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * The most turns a tenant may ask for in one session.
 *
 * `turn_cap` arrives inside the signed body, so it is the tenant's own attested choice
 * about the tenant's own budget — but a typo is not a choice. At the measured $0.0035 for
 * a cache-hit reply (D-072) forty turns is about $0.14, well inside a day's allowance,
 * while `40000` would be a single visitor consuming `SURFACE_HARD_CAP_USD_PER_TENANT_PER_DAY`
 * and taking the DM path down with it. The clamp is silent on purpose: refusing the mint
 * would turn a tenant's configuration mistake into an outage for their visitors.
 */
export const WEB_SESSION_MAX_TURN_CAP = 40;

/** Requests one address may make to the mint inside a window. */
export const MINT_RATE_LIMIT = 30;
export const MINT_RATE_WINDOW_MS = 60 * 1000;

/** A channel id is a uuid. Checked before it reaches a query. */
// ascii-safe: a uuid this platform generated, never customer text.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type MintEffects = {
  db: SupabaseClient;
  now: Date;
  /** The platform salt for `hashClientIp`. From the environment (rule 7). */
  ipSalt: string;
  /** Decrypt the tenant's `web_mint_secret`. Per request — never a module-scope cache. */
  loadMintSecret: (ref: { tenantId: string; channelId: string }) => Promise<
    { ok: true; secret: string } | { ok: false; retryable: boolean; code: string }
  >;
  verifyTurnstile: (token: string | null, remoteIp: string) => Promise<TurnstileOutcome>;
  log: (level: 'info' | 'warn' | 'error', event: string, fields?: Record<string, unknown>) => void;
};

export type MintRequest = {
  /** Exact bytes. NOT `req.text()` — see `verifyMintSignature`. */
  rawBody: Buffer;
  channelHeader: string | null;
  signatureHeader: string | null;
  clientIp: string;
};

export type MintResult = { status: number; body: Record<string, unknown> };

/** Refuse, logging the diagnosis and telling the caller only the category. */
function refuse(
  effects: MintEffects,
  refusal: MintRefusal | 'mint_rate_limited' | 'mint_bad_request',
  diagnosis: MintDiagnosis | string,
  status: number,
  fields: Record<string, unknown> = {},
): MintResult {
  effects.log(status >= 500 ? 'error' : 'warn', 'web_mint_refused', { refusal, diagnosis, ...fields });
  return { status, body: { error: refusal } };
}

/**
 * Pull `issued_at` and `turn_cap` out of the body WITHOUT trusting either yet.
 *
 * Parsing before verifying looks backwards, and is not: `verifyMintSignature` computes its
 * HMAC over the raw bytes and checks the timestamp only after that digest matches, so a
 * tampered body fails whatever this returns. The timestamp has to be read from inside the
 * body rather than from a header precisely so the signature covers it — a header value
 * would let an attacker replay an old body under a fresh time.
 *
 * Returns nulls rather than throwing. A body that is not JSON is indistinguishable, here,
 * from one whose signature is wrong, and the verifier is what says so.
 */
function peek(rawBody: Buffer): { issuedAt: Date | null; turnCap: number | null; turnstileToken: string | null } {
  const absent = { issuedAt: null, turnCap: null, turnstileToken: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return absent;
  }
  if (typeof parsed !== 'object' || parsed === null) return absent;
  const obj = parsed as Record<string, unknown>;

  const rawIssued = obj['issued_at'];
  const issuedAt = typeof rawIssued === 'string' ? new Date(rawIssued) : null;

  // `Number(null)` is 0 and `Number('')` is 0 — the same trap `session.ts` documents. The
  // raw type is checked before any coercion, so a null `turn_cap` is "absent", never zero.
  const rawCap = obj['turn_cap'];
  const turnCap = typeof rawCap === 'number' && Number.isInteger(rawCap) && rawCap > 0 ? rawCap : null;

  // The widget's `cf-turnstile-response`, forwarded by the tenant's server inside the
  // SIGNED body. It has to travel here rather than being read from a header for the same
  // reason `issued_at` does: anything outside the raw bytes is not covered by the HMAC, so
  // a relay could strip or swap it and the signature would still verify.
  const rawTurnstile = obj['turnstile_token'];
  const turnstileToken = typeof rawTurnstile === 'string' && rawTurnstile !== '' ? rawTurnstile : null;

  return { issuedAt, turnCap, turnstileToken };
}

export async function runMintJob(effects: MintEffects, req: MintRequest): Promise<MintResult> {
  const { db, now } = effects;

  // 1. Shape.
  const channelId = typeof req.channelHeader === 'string' ? req.channelHeader.trim() : '';
  if (!UUID_RE.test(channelId)) {
    return refuse(effects, 'mint_unauthorised', 'channel_unknown', 401, { reason: 'header shape' });
  }

  // 2. Resolve the channel. This SELECTS A CANDIDATE — the signature at step 4 decides.
  const { data: channel, error: channelErr } = await db
    .from('tenant_channels')
    .select('id, tenant_id, provider, status, delivery_mode')
    .eq('id', channelId)
    .maybeSingle();

  // Rule 2: 503 on any error, never a refusal that reads as "no such channel". A database
  // blip must not be reported to a tenant as a credential problem — they would go and
  // rotate a working secret.
  if (channelErr) {
    return refuse(effects, 'mint_unavailable', 'secret_unreadable', 503, { detail: channelErr.message });
  }
  if (channel === null) {
    return refuse(effects, 'mint_unauthorised', 'channel_unknown', 401, { channelId });
  }

  const row = channel as Record<string, unknown>;
  const tenantId = String(row['tenant_id']);
  if (row['provider'] !== 'web') {
    return refuse(effects, 'mint_unauthorised', 'channel_not_web', 401, { channelId, provider: row['provider'] });
  }
  if (row['status'] !== 'active') {
    return refuse(effects, 'mint_unauthorised', 'channel_inactive', 401, { channelId, status: row['status'] });
  }

  // 3. Rate-limit, before any decryption. Keyed on the address rather than the channel:
  // the thing being bounded is one caller opening sessions in a loop, and a tenant's own
  // server calling at a normal rate from one address must not be throttled by an attacker
  // naming the same channel from another.
  const ipHashBytes = hashClientIp(req.clientIp, effects.ipSalt);
  const ipHash = ipHashBytes.toString('hex');
  const rate = await consumeRate(
    db,
    { tenantId, bucketKey: `mint:${ipHash}`, limit: MINT_RATE_LIMIT, windowMs: MINT_RATE_WINDOW_MS },
    now,
  );
  if (!rate.ok) {
    return rate.reason === 'rate_limited'
      ? refuse(effects, 'mint_rate_limited', 'rate_limited', 429, { tenantId, count: rate.count })
      // Fails CLOSED. A limiter that cannot be consulted, in front of anonymous traffic
      // against a paid model, must refuse.
      : refuse(effects, 'mint_unavailable', 'rate_unavailable', 503, { tenantId, detail: rate.detail });
  }

  // 4. The secret, then the signature. THIS is where the tenant is derived.
  const secret = await effects.loadMintSecret({ tenantId, channelId });
  if (!secret.ok) {
    return secret.retryable
      ? refuse(effects, 'mint_unavailable', 'secret_unreadable', 503, { tenantId, code: secret.code })
      // An absent or revoked secret is the SAME answer as a wrong signature. A tenant that
      // has not been provisioned and a caller guessing at channel ids must not be
      // distinguishable from outside.
      : refuse(effects, 'mint_unauthorised', 'secret_missing', 401, { tenantId, code: secret.code });
  }

  const { issuedAt, turnCap, turnstileToken } = peek(req.rawBody);
  const verified = verifyMintSignature(req.rawBody, req.signatureHeader, secret.secret, issuedAt, now);
  if (!verified.ok) {
    const status = verified.refusal === 'mint_unavailable' ? 503 : 401;
    return refuse(effects, verified.refusal, verified.diagnosis, status, { tenantId, channelId });
  }

  // From here the caller is proven to hold the tenant's secret, so refusals may be
  // specific: they are being read by the tenant's own engineer, not by a stranger.
  if (turnCap === null) {
    return refuse(effects, 'mint_bad_request', 'turn_cap_missing', 400, { tenantId });
  }

  // 5. Turnstile, behind the HMAC.
  const human = await effects.verifyTurnstile(turnstileToken, req.clientIp);
  if (!human.ok) {
    if (human.reason === 'turnstile_unavailable') {
      return refuse(effects, 'mint_unavailable', 'turnstile_unavailable', 503, { tenantId, detail: human.detail });
    }
    effects.log('warn', 'web_mint_refused', { refusal: human.reason, tenantId });
    return { status: 403, body: { error: human.reason } };
  }

  // 6. The session.
  const { token, tokenSha256 } = newSessionToken();
  const expiresAt = new Date(now.getTime() + WEB_SESSION_TTL_MS);
  const cap = Math.min(turnCap, WEB_SESSION_MAX_TURN_CAP);

  const { data: created, error: insertErr } = await db
    .from('web_sessions')
    .insert({
      tenant_id: tenantId,
      channel_id: channelId,
      token_sha256: `\\x${tokenSha256.toString('hex')}`,
      issued_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      turns: 0,
      turn_cap: cap,
      client_ip_hash: `\\x${ipHash}`,
    })
    .select('id')
    .maybeSingle();

  if (insertErr || created === null) {
    return refuse(effects, 'mint_unavailable', 'session_insert_failed', 503, {
      tenantId,
      detail: insertErr?.message ?? 'insert returned no row',
    });
  }

  effects.log('info', 'web_mint_ok', {
    tenantId,
    channelId,
    sessionId: String((created as Record<string, unknown>)['id']),
    turnCap: cap,
    clamped: cap !== turnCap,
    deliveryMode: row['delivery_mode'],
  });

  // The token is in the body and NOT in a Set-Cookie: the tenant's server is the one
  // receiving it, and it hands it to its own page however it likes. A cookie would bind it
  // to our domain, which is the one place it is useless.
  return {
    status: 200,
    body: { token, expires_at: expiresAt.toISOString(), turn_cap: cap },
  };
}
