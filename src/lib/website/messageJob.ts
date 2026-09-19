/**
 * `POST /api/web/message` — one turn of a website conversation, as a testable job.
 *
 * The mint proved who the TENANT is. This proves nothing about the visitor and does not
 * try to: the browser sends back the opaque token the platform issued, and the tenant
 * comes from looking it up. No field of this request names a tenant, a channel or a
 * conversation, so there is nothing for a caller to choose and nothing to derive wrongly.
 *
 * ## It reuses the reply path rather than reimplementing it
 *
 * `loadReceptionContext`, `renderVolatile`, `withTenantRole` and `handleReception` are the
 * same functions the Messenger worker calls, in the same order, with the same meanings.
 * That is the point of the channel: the founder asked for "same prompt, gate blocks,
 * guards, publish path and model as Matrix", and the way to get that is to call the same
 * code, not to write a second reply path that agrees with the first until it doesn't.
 *
 * `channel: 'web'` is the only substantive difference, and it needs no code: `config_snapshots`
 * is keyed `(tenant_id, revision_id, channel)`, and `scripts/publish/tenant.ts` already
 * reads a tenant's channels off `tenant_channels.provider` and compiles one snapshot per
 * channel. A `provider = 'web'` row is therefore the whole of "publish for the website" —
 * rows, not code, which is the test every decision here is measured against.
 *
 * ## The surface is `direct_message`, and that is a decision rather than a default
 *
 * D-082: a provider is not a surface, and Ш0 asks the model whether its reply is publicly
 * visible. A widget on the tenant's own site is a private one-to-one conversation — nobody
 * else reads it — so `direct_message` is the true answer. Answering `public_comment` here
 * would serve `refusal_public_channel` ("please write to us privately") to somebody who
 * already is, which is precisely the bug D-082 was raised for on the Facebook side.
 *
 * ## Two orderings that are load-bearing
 *
 * **The spend guard runs before the turn is claimed.** A visitor whose reply is refused for
 * the tenant's ceiling has not had a turn, and burning one would charge them for an answer
 * they never got. **The turn is claimed before the model is called** — rule 3: a ceiling
 * checked after the call is not a ceiling. Both hold because the guard costs no model
 * tokens: the only thing between the claim and the provider call is `handleReception`.
 *
 * ## CORS here, and none on the mint
 *
 * The mint is server-to-server. This is the browser-facing half, so it needs an
 * `Access-Control-Allow-Origin` or no reply ever reaches the page. The allow-list is
 * `tenant_domains`, which has existed since `0001` with no reader anywhere — this is it.
 * `verified_at` gates a row because a host nobody confirmed is not an allow-list entry;
 * read it as "an operator confirmed this host", since nothing in this platform performs an
 * automated domain check and claiming otherwise would be a comment asserting a control
 * that was never built.
 *
 * And the thing to keep straight, because it is the mistake this whole channel is built
 * against: **CORS is not the authorization.** The token is. An attacker with a stolen token
 * calls this from curl with no Origin header at all and CORS never enters into it —
 * `Matrix-Chatbot/lib/cors.js` says so in its own first ten lines. The allow-list is here
 * so a stolen token cannot be spent from a page the tenant does not control *by a victim's
 * browser*, and so the widget works. It is a second lock on a door whose first lock is the
 * one that matters.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveSession, claimTurn, type SessionRefusal } from './session.ts';
import { consumeRate } from './ratelimit.ts';
import { hashClientIp } from './mint.ts';
import type { TenantSettings, LoadOutcome } from '../reception/load.ts';
import { renderVolatile, type Surface as VolatileSurface } from '../reception/volatile.ts';
import type { GuardResult } from '../guard/withTenantRole.ts';
import { ensureContact, openConversation, readHistory, recordInbound, traceAnswer } from '../inbound/persist.ts';
import { claim, markSent } from '../outbound/claim.ts';
import { tenantClock } from '../time/clock.ts';
import { RECEPTION_HISTORY_TURNS } from '../model/reception.ts';
import { usdToNano } from '../money.ts';
import type { ReceptionOutcome } from '../reception/handle.ts';
import type { ReceptionContext } from '../reception/load.ts';
import type { Turn } from '../inbound/persist.ts';
import type { Reservation } from '../spend/reserve.ts';

/** A widget conversation is private. D-082. */
const WEB_SURFACE: VolatileSurface = 'direct_message';

/** The channel key for `config_snapshots` and the guard. */
export const WEB_CHANNEL = 'web';

/**
 * The longest message a widget may send.
 *
 * Counted in CODE POINTS, never bytes: rule 6 forbids reading byte length as character
 * length, and Mongolian Cyrillic is two bytes a letter, so a byte bound would silently cut
 * a Mongolian visitor's message at half the length of an English one. 2,000 code points is
 * far past any real enquiry and well short of anything worth paying to tokenise.
 */
export const MAX_MESSAGE_CHARS = 2_000;

/** Turns one session may take inside a window, on top of the absolute `turn_cap`. */
export const MESSAGE_RATE_LIMIT = 10;

/**
 * Turns one ADDRESS may take inside the same window, across every session it holds.
 *
 * Sized as a blast-radius cap rather than a per-visitor limit: school, office and mobile
 * carrier NAT put many genuine people behind one address, and a limit tuned to a single
 * visitor would refuse a real customer to inconvenience an attacker who can change address
 * anyway. `dalatech-english`'s per-IP backstop is sized on the same reasoning.
 */
export const MESSAGE_IP_RATE_LIMIT = 60;

export const MESSAGE_RATE_WINDOW_MS = 60 * 1000;

export type MessageEffects = {
  db: SupabaseClient;
  now: Date;
  ipSalt: string;
  /**
   * The compiled configuration for this tenant's WEB channel.
   *
   * Injected rather than called directly, for the reason `WorkerEffects` injects
   * `generateReply`: `loadReceptionContext` fans out across a dozen tables, and a job that
   * calls it inline can only be tested by faking all of them — which means in practice it
   * is not tested, and the orderings below are the whole point of this file.
   */
  loadContext: (args: { tenantId: string; settings: TenantSettings; localDate: string }) => Promise<LoadOutcome>;
  /** `withTenantRole`, the money chokepoint. Injected for the same reason. */
  checkGuard: (args: { tenantId: string; conversationId: string; timezone: string }) => Promise<GuardResult>;
  /** The same `handleReception` binding the Messenger worker uses. */
  generateReply: (args: {
    tenantId: string;
    channelId: string;
    conversationId: string;
    inboundExternalId: string;
    reservation: Reservation;
    customerMessage: string;
    history: readonly Turn[];
    eventAt: Date;
    promptVolatile: string;
    ctx: ReceptionContext;
    historyEmpty: boolean;
  }) => Promise<ReceptionOutcome>;
  log: (level: 'info' | 'warn' | 'error', event: string, fields?: Record<string, unknown>) => void;
};

export type MessageRequest = {
  token: string;
  text: string;
  /** The browser's `Origin`, or null when the caller sent none. */
  origin: string | null;
  clientIp: string;
};

export type MessageResult = {
  status: number;
  body: Record<string, unknown>;
  /** What the route should echo in `Access-Control-Allow-Origin`, when anything. */
  allowOrigin?: string;
};

/** Every session refusal, mapped to what the visitor's browser is told. */
const SESSION_STATUS: Record<SessionRefusal, number> = {
  session_unknown: 401,
  session_expired: 401,
  session_revoked: 401,
  session_exhausted: 429,
  session_unavailable: 503,
};

export async function runMessageJob(effects: MessageEffects, req: MessageRequest): Promise<MessageResult> {
  const { db, now } = effects;
  const refuse = (status: number, error: string, fields: Record<string, unknown> = {}): MessageResult => {
    effects.log(status >= 500 ? 'error' : 'warn', 'web_message_refused', { error, ...fields });
    return { status, body: { error } };
  };

  // --- 1. Identity: the token, and nothing else. ----------------------------
  const resolved = await resolveSession(db, req.token, now);
  if (!resolved.ok) {
    return refuse(SESSION_STATUS[resolved.refusal], resolved.refusal, { detail: resolved.detail });
  }
  const session = resolved.session;
  const { tenantId, channelId } = session;

  // --- 2. Origin, now that we know whose allow-list to read. ----------------
  const { data: domains, error: domainErr } = await db
    .from('tenant_domains')
    .select('host, verified_at')
    .eq('tenant_id', tenantId);
  // Rule 2. An unreadable allow-list is not an empty one and is not a permissive one.
  if (domainErr) return refuse(503, 'origin_unavailable', { tenantId, detail: domainErr.message });

  const allowed = new Set(
    (Array.isArray(domains) ? domains : [])
      .map((raw) => raw as Record<string, unknown>)
      .filter((r) => r['verified_at'] !== null && r['verified_at'] !== undefined)
      .map((r) => String(r['host']).toLowerCase()),
  );

  let allowOrigin: string | undefined;
  if (req.origin !== null && req.origin !== '') {
    let host: string;
    try {
      host = new URL(req.origin).host.toLowerCase();
    } catch {
      return refuse(403, 'origin_not_allowed', { tenantId, origin: req.origin });
    }
    if (!allowed.has(host)) return refuse(403, 'origin_not_allowed', { tenantId, origin: req.origin });
    allowOrigin = req.origin;
  }

  const withOrigin = (r: MessageResult): MessageResult =>
    allowOrigin === undefined ? r : { ...r, allowOrigin };

  // --- 3. The message itself. -----------------------------------------------
  // Measured with the spread operator, which iterates code points, so an emoji or a
  // Mongolian letter counts once. `String.length` is UTF-16 units and would count some of
  // both twice.
  const text = typeof req.text === 'string' ? req.text : '';
  if (text.trim() === '') return withOrigin(refuse(400, 'empty_message', { tenantId }));
  if ([...text].length > MAX_MESSAGE_CHARS) {
    return withOrigin(refuse(413, 'message_too_long', { tenantId, chars: [...text].length }));
  }

  // --- 4. Rate limit, per session AND per address. --------------------------
  //
  // Two buckets, because one is not enough and the arithmetic says so. The session bucket
  // bounds a conversation; the address bucket bounds a CALLER, who can hold many sessions.
  // At the mint's 30 sessions a minute from one address, a session-only limit would permit
  // 30 × MESSAGE_RATE_LIMIT turns a minute from that address — a limiter whose number does
  // not mean what it appears to mean, which is the specific criticism `ratelimit.ts` makes
  // of the ancestor's in-process Map.
  //
  // The address bucket is deliberately not `MESSAGE_RATE_LIMIT`: a household, an office or
  // a mobile carrier behind NAT is many genuine visitors on one address, and
  // `dalatech-english` sizes its own per-IP backstop to survive exactly that. It is a
  // blast-radius cap, not the real control; `turn_cap` and the daily ceiling are.
  const ipHash = hashClientIp(req.clientIp, effects.ipSalt).toString('hex');
  for (const bucket of [
    { key: `msg:${session.id}`, limit: MESSAGE_RATE_LIMIT },
    { key: `msgip:${ipHash}`, limit: MESSAGE_IP_RATE_LIMIT },
  ]) {
    const rate = await consumeRate(
      db,
      { tenantId, bucketKey: bucket.key, limit: bucket.limit, windowMs: MESSAGE_RATE_WINDOW_MS },
      now,
    );
    if (!rate.ok) {
      return withOrigin(
        rate.reason === 'rate_limited'
          ? refuse(429, 'rate_limited', { tenantId, bucket: bucket.key, count: rate.count })
          : refuse(503, 'rate_unavailable', { tenantId, bucket: bucket.key, detail: rate.detail }),
      );
    }
  }

  // --- 5. Tenant settings. --------------------------------------------------
  const { data: tenantRow, error: tenantErr } = await db
    .from('tenants')
    .select('default_locale, prompt_cache_mode, timezone')
    .eq('id', tenantId)
    .maybeSingle();
  if (tenantErr || tenantRow === null) {
    return withOrigin(refuse(503, 'tenant_unavailable', { tenantId, detail: tenantErr?.message ?? 'no tenant row' }));
  }
  const t = tenantRow as Record<string, unknown>;
  const timezone = t['timezone'];
  if (typeof timezone !== 'string' || timezone === '') {
    // The budget step keys on the tenant's calendar. A default here is a silent wrong
    // answer for every tenant whose row is incomplete, on the money path.
    return withOrigin(refuse(503, 'tenant_timezone_missing', { tenantId }));
  }
  const settings: TenantSettings = {
    defaultLocale: String(t['default_locale'] ?? 'mn'),
    promptCacheMode: (t['prompt_cache_mode'] ?? 'off') as TenantSettings['promptCacheMode'],
  };
  const localDate = tenantClock(now, timezone).date;

  // --- 6. The compiled configuration, for the WEB channel. ------------------
  const loaded = await effects.loadContext({ tenantId, settings, localDate });
  if (!loaded.ok) {
    // `not_provisioned` is determinate — no snapshot has been published for this channel,
    // which a retry cannot change and no default can stand in for. Both are 503 to the
    // browser because the visitor's only sane action is to try later either way, but they
    // are different lines in the log and only one of them is somebody's to fix.
    return withOrigin(refuse(503, `context_${loaded.code}`, { tenantId, detail: loaded.detail }));
  }
  const ctx = loaded.context;

  const promptVolatile = renderVolatile({
    now, timezone, surface: WEB_SURFACE, hours: ctx.hours, closures: ctx.closures,
  });

  // --- 7. Persist the visitor's turn. ---------------------------------------
  // The contact's external id is the SESSION, not the visitor: an anonymous browser has no
  // durable identity, and inventing one — a cookie, a fingerprint — would be claiming to
  // know something we do not. One session is one contact is one conversation, so history
  // is per session by construction, which is also what a widget's user expects when they
  // reload the page.
  const contact = await ensureContact(db, { tenantId, channelId, externalId: `web:${session.id}`, now });
  if (!contact.ok) return withOrigin(refuse(503, 'contact_failed', { tenantId, detail: contact.detail }));

  const conversation = await openConversation(db, {
    tenantId, contactId: contact.value.contactId, channelId, now,
  });
  if (!conversation.ok) {
    return withOrigin(refuse(503, 'conversation_failed', { tenantId, detail: conversation.detail }));
  }
  const conversationId = conversation.value.conversationId;

  // The turn number makes this unique within the session, which is what `messages`'
  // uniqueness on `(tenant_id, conversation_id, external_id)` wants. Stated plainly: a
  // network retry after a successful claim is a NEW turn and is answered again, because
  // the browser has no idempotency key and inventing one it did not send would be a dedup
  // key that cannot tell two messages apart — D-039, from the side that costs money rather
  // than the side that loses messages. `turn_cap` is what bounds the damage.
  const inboundExternalId = `web:${session.id}:${session.turns}`;
  const stored = await recordInbound(db, {
    tenantId, conversationId, externalId: inboundExternalId, body: text, now,
  });
  if (!stored.ok) return withOrigin(refuse(503, 'inbound_failed', { tenantId, detail: stored.detail }));

  // Read AFTER storing, then drop the last turn: otherwise the model sees this question
  // twice, once as history and once as the question.
  const history = await readHistory(db, { tenantId, conversationId, limit: RECEPTION_HISTORY_TURNS + 1 });
  if (!history.ok) {
    // An unreadable history is never an empty one — without the distinction a hiccup makes
    // the bot greet a visitor mid-conversation from scratch.
    return withOrigin(refuse(503, 'history_failed', { tenantId, detail: history.detail }));
  }
  const priorTurns = history.value.slice(0, -1);

  // --- 8. The money chokepoint. Nothing here re-implements any part of it. ---
  const guard = await effects.checkGuard({ tenantId, conversationId, timezone });
  if (!guard.ok) {
    const { refusal } = guard;
    effects.log('warn', 'web_message_refused', {
      error: refusal.code, tenantId,
      ...(refusal.code === 'guard_unavailable' ? { detail: refusal.detail } : {}),
    });
    // §5.7: never silence. A determinate refusal still answers, with the tenant's own
    // reviewed handoff line — the same sentence `handleReception` would have served, from
    // the same rows, rather than a bare error code rendered in a chat bubble.
    if (refusal.status !== 503) {
      const handoff = ctx.canned.find((c) => c.kind === 'handoff' && c.reviewedAt !== null);
      if (handoff !== undefined) {
        return withOrigin({ status: 200, body: { reply: handoff.body, answered_by: 'canned', refusal: refusal.code } });
      }
    }
    return withOrigin({ status: refusal.status === 503 ? 503 : 200, body: { error: refusal.code } });
  }

  // --- 9. Claim the turn, THEN call the model. ------------------------------
  // Rule 3 stated exactly: the bound is taken before the spend, not after. The guard above
  // costs no model tokens, so putting it first does not weaken this.
  const claimed = await claimTurn(db, session, now);
  if (!claimed.ok) {
    return withOrigin(refuse(SESSION_STATUS[claimed.refusal], claimed.refusal, { tenantId, detail: claimed.detail }));
  }

  const outcome = await effects.generateReply({
    tenantId, channelId, conversationId,
    inboundExternalId,
    reservation: guard.reservation,
    customerMessage: text,
    history: priorTurns,
    eventAt: now,
    promptVolatile,
    ctx,
    historyEmpty: priorTurns.length === 0,
  });

  if (outcome.kind === 'retry') {
    return withOrigin(refuse(503, 'reception_retry', { tenantId, detail: outcome.detail }));
  }
  if (outcome.kind === 'dropped') {
    return withOrigin(refuse(503, 'reception_dropped', { tenantId, reason: outcome.reason }));
  }

  // What answered this visitor, on the visitor's own row. Best-effort, exactly as the
  // Messenger path treats it: the reply already exists, so a trace that cannot be written
  // is evidence lost, and refusing over it would be worse (D-064).
  const traced = await traceAnswer(db, {
    tenantId, messageId: stored.value.messageId, answeredBy: outcome.answeredBy,
    revisionId: ctx.revisionId, promptHash: ctx.contentHash,
  });
  if (!traced.ok) effects.log('error', 'trace_failed', { tenantId, conversationId, detail: traced.detail ?? '' });

  // --- 10. Claim the draft and hand it over. --------------------------------
  // The transport IS this HTTP response, so claim/markSent still apply: the same CAS that
  // stops two Messenger workers sending twice stops two concurrent requests handing the
  // same draft to the visitor twice, and the row records that it was delivered.
  const held = await claim(db, { id: outcome.outboundId, tenantId, now });
  if (held.outcome === 'unavailable') {
    return withOrigin(refuse(503, 'claim_unavailable', { tenantId, detail: held.detail }));
  }
  if (held.outcome !== 'claimed') {
    // Somebody already delivered it, or holds a live lease. Either way it is not ours to
    // hand over a second time.
    return withOrigin(refuse(409, 'reply_already_delivered', { tenantId, outcome: held.outcome }));
  }

  // A real, non-null id naming the transport that carried it. Not cosmetic: D-080 reads a
  // null `provider_message_id` as "not ours", and a web reply is emphatically ours.
  const providerMessageId = `web:${session.id}:${claimed.turn}`;
  const marked = await markSent(db, {
    id: outcome.outboundId, tenantId, providerMessageId, unitCost: usdToNano(0), now,
  });
  if (!marked.ok) {
    // The visitor is about to receive the reply whatever this row says, so refusing here
    // would withhold a delivered answer to keep a ledger tidy. Logged loudly instead.
    effects.log('error', 'web_mark_sent_failed', { tenantId, outboundId: outcome.outboundId, detail: marked.detail });
  }

  effects.log('info', 'web_message_answered', {
    tenantId, channelId, conversationId, sessionId: session.id,
    turn: claimed.turn, turnCap: session.turnCap, answeredBy: outcome.answeredBy,
    ...(outcome.refusal === undefined ? {} : { refusal: outcome.refusal }),
  });

  return withOrigin({
    status: 200,
    body: {
      reply: held.body,
      answered_by: outcome.answeredBy,
      turns_remaining: Math.max(0, session.turnCap - claimed.turn),
      ...(outcome.refusal === undefined ? {} : { refusal: outcome.refusal }),
    },
  });
}
