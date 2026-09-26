/**
 * `POST /api/web/message` — one turn of a website conversation.
 *
 * The browser-facing half. **Everything this route decides lives in
 * `@/lib/website/messageJob`**; what is left here is the binding, and the rule from
 * `api/workers/reception/route.ts` holds: **nothing in this file may branch.**
 *
 * ## The preflight is permissive on purpose, and grants nothing
 *
 * A cross-origin POST carrying `content-type: application/json` is preflighted, and the
 * preflight has no body and no token — so there is no session to look an allow-list up
 * from, and refusing it would mean refusing every legitimate widget. It therefore reflects
 * whatever `Origin` asked.
 *
 * That is safe for one reason, and the reason is worth stating rather than assuming: a
 * preflight returns no data. It tells a browser it MAY send the real request; the real
 * request is then checked against `tenant_domains` and refused there if the origin is not
 * the tenant's. A permissive preflight in front of an enforcing POST gives an attacker the
 * right to be told no.
 *
 * And the point `Matrix-Chatbot/lib/cors.js` makes in its own first ten lines, which this
 * channel is built around: CORS is a browser control, not an authorization gate. The token
 * is the authorization. Nothing here is load-bearing against a caller who is not a browser.
 */
import { NextResponse, after } from 'next/server';
import { supabaseWorker } from '@/lib/supabase/clients';
import { handleReception } from '@/lib/reception/handle';
import { loadReceptionContext } from '@/lib/reception/load';
import { withTenantRole } from '@/lib/guard/withTenantRole';
import { RECEPTION_REPLY_ESTIMATE } from '@/lib/worker/reception';
import { WEB_CHANNEL } from '@/lib/website/messageJob';
import { buildDeps } from '@/lib/reception/deps';
import { MODEL_REGISTRY, RECEPTION_UPSTREAM_TIMEOUT_MS } from '@/config/platform';
import { SECTION_LABELS } from '@/lib/prompt/tenant';
import { required } from '@/lib/env';
import { clientIpOf } from '@/lib/website/clientIp';
import { runMessageJob, type MessageEffects } from '@/lib/website/messageJob';
import { salesShadowEffect } from '@/lib/sales/shadow';
import { alertWebHandoff } from '@/lib/website/handoffAlert';
import { servicesFromPrefix, sectionRows, faqAnswersFromPrefix } from '@/lib/quality/serviceNames';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Headers a preflight is told it may send.
 *
 * `content-type` and nothing else: the session token travels in the JSON body, not in an
 * `Authorization` header. Advertising a header this route does not read would be a
 * contract that lies — and a custom header is what triggers the preflight in the first
 * place, so keeping the credential in the body costs one fewer round trip per turn.
 */
const PREFLIGHT_HEADERS = 'content-type';

function effects(now: Date): MessageEffects {
  const db = supabaseWorker();
  return {
    db,
    now,
    ipSalt: required('CLIENT_IP_SALT'),

    // `channel: WEB_CHANNEL` is the whole of "the website's configuration": one
    // `config_snapshots` row per channel, compiled by the same publish path.
    loadContext: ({ tenantId, settings, localDate }) =>
      loadReceptionContext(db, { tenantId, channel: WEB_CHANNEL, settings, localDate }),

    // Reception's surface and Reception's estimate. A website turn and a Messenger turn
    // are the same staff spending the same budget — D-086 — so they share a ceiling by
    // construction rather than by a second number that could drift from this one.
    checkGuard: ({ tenantId, conversationId, timezone }) =>
      withTenantRole(db, {
        tenantId, role: 'reception', surface: 'reception', channel: WEB_CHANNEL,
        estimate: RECEPTION_REPLY_ESTIMATE, conversationId, now, timezone,
      }),

    // The SAME binding the Messenger worker uses, with the same arguments and the same
    // meanings. A second reply path that merely resembles the first is the thing this
    // channel exists to avoid.
    generateReply: (a) =>
      handleReception(
        buildDeps({
          db,
          tenantId: a.tenantId,
          channelId: a.channelId,
          conversationId: a.conversationId,
          cacheMode: a.ctx.cacheMode,
          inboundExternalId: a.inboundExternalId,
          reservation: a.reservation,
          now,
        }),
        {
          customerMessage: a.customerMessage,
          // A widget sends text. There is no attachment surface here, and the field is
          // required rather than defaulted precisely so a caller cannot forget it and have
          // "no attachment" asserted on its behalf (D-083).
          customerAttachments: [],
          customerSentPhoto: false,
          history: a.history,
          eventAt: a.eventAt,
          now,
          promptStable: a.ctx.promptStable,
          promptVolatile: a.promptVolatile,
          modelId: MODEL_REGISTRY.reception,
          cacheMode: a.ctx.cacheMode,
          timeoutMs: RECEPTION_UPSTREAM_TIMEOUT_MS,
          rules: a.ctx.rules,
          deterministic: a.ctx.deterministic,
          days: a.ctx.days,
          historyState: { known: true, empty: a.historyEmpty },
          canned: a.ctx.canned,
          tenantGuard: a.ctx.tenantGuard,
          cannedLabel: SECTION_LABELS.canned,
          serviceNames: servicesFromPrefix(a.ctx.promptStable, SECTION_LABELS.priceList),
          serviceAliases: a.ctx.serviceAliases,
          spellings: a.ctx.spellings,
          depositRows: sectionRows(a.ctx.promptStable, SECTION_LABELS.deposits),
          faqAnswers: faqAnswersFromPrefix(a.ctx.promptStable, SECTION_LABELS.faqs),
          branches: a.ctx.branches,
          cannedHash: a.ctx.cannedHash,
          fallbackLine: a.ctx.fallbackLine,
          // A widget has no inbox: nobody reads this conversation unless told (D-139).
          noInbox: true,
          // The site the visitor is on is never where they are sent (D-140).
          ownSiteHosts: a.ownSiteHosts,
          complaintRules: a.ctx.complaintRules,
          sales: a.ctx.sales,
          replyStyle: a.ctx.replyStyle,
        },
      ),

    // The SAME binding the Messenger worker uses (`api/workers/reception/route.ts`), so a
    // lead left in the widget is recorded and routed exactly as one left on the Page.
    salesShadow: (a) =>
      salesShadowEffect(db, {
        tenantId: a.tenantId,
        conversationId: a.conversationId,
        messageId: a.messageId,
        outboundId: a.outboundId,
        customerMessage: a.customerMessage,
        customerSentPhoto: a.customerSentPhoto,
        history: a.history,
        refusal: a.refusal,
        threadControl: a.threadControl,
        promptStable: a.ctx.promptStable,
        canned: a.ctx.canned,
        deterministic: a.ctx.deterministic,
        spellings: a.ctx.spellings,
        now,
      }),

    afterResponse: (work) => after(work),

    // Logged and swallowed: the reply is already on its way (D-139).
    alertHandoff: async (a) => {
      try {
        const r = await alertWebHandoff(db, {
          tenantId: a.tenantId, conversationId: a.conversationId, messageId: a.messageId,
          question: a.question, playbook: a.ctx.sales, now,
        });
        if (r.outcome === 'unusable') console.error('[web] web_handoff_alert_failed', { tenantId: a.tenantId, detail: r.detail });
        else console.info('[web] web_handoff_alert', { tenantId: a.tenantId, conversationId: a.conversationId, outcome: r.outcome });
      } catch (e) {
        console.error('[web] web_handoff_alert_threw', { tenantId: a.tenantId, detail: e instanceof Error ? e.message : String(e) });
      }
    },

    log: (level, event, fields) => console[level](`[web] ${event}`, fields ?? {}),
  };
}

export async function OPTIONS(request: Request): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': request.headers.get('origin') ?? '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': PREFLIGHT_HEADERS,
      'access-control-max-age': '600',
      vary: 'Origin',
    },
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const result = await runMessageJob(effects(new Date()), {
    token: String(payload['token'] ?? ''),
    text: String(payload['text'] ?? ''),
    origin: request.headers.get('origin'),
    clientIp: clientIpOf(request.headers),
  });
  return NextResponse.json(result.body, {
    status: result.status,
    headers: {
      vary: 'Origin',
      ...(result.allowOrigin === undefined ? {} : { 'access-control-allow-origin': result.allowOrigin }),
    },
  });
}
