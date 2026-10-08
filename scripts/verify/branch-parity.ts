/**
 * Two branches of one brand, answered end to end: every kind of Messenger message and Page
 * comment a branch's Дали handles, sent to EACH branch's Page through the production path —
 * `handleMetaEntry` (routing, dedup, the ledger), then `runReceptionJob` (the worker: the
 * gate, fixed replies, pinned lines, photo / reel / voice / like / sticker handling, hand-off,
 * comments, adverts) — over a real PostgREST and PostgreSQL holding the tenants' rows.
 *
 *     NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54327 SUPABASE_SECRET_PUBLISH=<local jwt> \
 *       node scripts/verify/branch-parity.ts --a matrix-eco-salon --a-branch Яармаг \
 *         --b tara-park-od --b-branch "Парк Од" [--shadow-testers]
 *
 * LOCAL REPLICA ONLY. It writes webhook events, conversations and replies, so it refuses any
 * URL that is not 127.0.0.1 / localhost. Both tenants must be published there and their
 * Messenger channels live with an active token status (the replica's own rows: nothing is
 * sent anywhere). Meta is a recorder; the model is a stub that refuses and is counted, so a
 * message the rows cannot answer shows as «model» (and gets the tenant's pinned hand-off
 * line) and nothing is spent. Comment lookups answer «no tag, post one day old».
 *
 * For each scenario it checks, for BOTH tenants, that the customer receives exactly the
 * expected row of THAT tenant (its own bytes), that the two tenants reach the model in the
 * same cases, and that no reply of one branch carries the other branch's phone numbers,
 * address or hairdressers outside the one row that names the other branch on purpose.
 * Exit 0 only when every check passes. Written for Парк Од's onboarding (2026-10-05); the
 * slugs are arguments, never literals in the logic. Not covered: two workers racing for one
 * reply (the claim's lease condition is dropped locally, below), Graph's own behaviour.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js'; // guard-ok: scripts/, not src/ (a local replica client with one rewrite, below)
import { handleMetaEntry, type MetaEntry } from '../../src/lib/webhook/entry.ts';
import { runReceptionJob, type WorkerEffects } from '../../src/lib/worker/reception.ts';
import { handleReception } from '../../src/lib/reception/handle.ts';
import { buildDeps } from '../../src/lib/reception/deps.ts';
import { SECTION_LABELS } from '../../src/lib/prompt/tenant.ts';
import { servicesFromPrefix, sectionRows, faqAnswersFromPrefix } from '../../src/lib/quality/serviceNames.ts';
import { MODEL_REGISTRY, RECEPTION_UPSTREAM_TIMEOUT_MS } from '../../src/config/platform.ts';
import { LIKE_STICKER_IDS } from '../../src/lib/inbound/like.ts';
import { deliverOutbound } from '../../src/lib/outbound/deliver.ts';
import { buildDeliverDeps } from '../../src/lib/outbound/deliverDeps.ts';

const usage = (): never => {
  console.error('usage: node scripts/verify/branch-parity.ts --a <slug> --a-branch <name> --b <slug> --b-branch <name>');
  process.exit(2);
};
const raw = (name: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i === -1 ? undefined : process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? usage() : v;
};
const slugArg = (name: string): string => {
  const v = raw(name);
  return /^[a-z0-9-]+$/.test(v) ? v : usage(); // ascii-safe: slugs are ASCII identifiers
};
const SLUG_A = slugArg('a');
const SLUG_B = slugArg('b');
// The name customers use for each branch («… салбар хаана байдаг вэ?»).
// A branch still in shadow is tested the way the founder tests it from his phone (D-141): each
// scenario's sender is put on the channel's `test_sender_ids`, so only that sender is answered.
const SHADOW_TESTERS = process.argv.includes('--shadow-testers');
const BRANCH: Record<string, string> = { [SLUG_A]: raw('a-branch').normalize('NFC'), [SLUG_B]: raw('b-branch').normalize('NFC') };
const url = process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? '';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(url)) {
  console.error(`refusing: ${url || '(unset)'} is not a local replica (this script writes conversations)`);
  process.exit(2);
}
// One local-only rewrite. `claim()` (outbound/claim.ts) PATCHes with an `or=(lease_until…)`
// filter and `select=id,body,attempts`. Production's PostgREST answers that 200 (its edge log,
// 2026-10-04: 40 such PATCHes, all 200); every PostgREST binary tried locally (11.2.2, 12.0.3,
// 12.2.3, 12.2.12, 13.0.4, 14.1) answers 400 «column outbound_messages.lease_until does not
// exist», because it re-applies the filter to the returned columns. Here, where one script
// sends one message at a time, the lease condition is always true, so it is dropped from that
// one request and every other request goes through untouched.
const key = process.env['SUPABASE_SECRET_PUBLISH'] ?? '';
if (key === '') { console.error('SUPABASE_SECRET_PUBLISH (the replica\'s local service token) is not set'); process.exit(2); }
const localFetch: typeof fetch = (input, init) => {
  const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (init?.method === 'PATCH' && u.includes('/outbound_messages?') && u.includes('or=%28lease_until')) {
    return fetch(u.replace(/&or=%28lease_until[^&]*/, ''), init);
  }
  return fetch(input, init);
};
const db = createClient(url, key, { auth: { persistSession: false }, global: { fetch: localFetch } });

// ---- the tenants ---------------------------------------------------------------------------
type Tenant = {
  slug: string; id: string; channelId: string; pageId: string; appSlug: string;
  /** In shadow, each scenario's sender is added to `test_sender_ids` first: the founder's own test. */
  shadow: boolean;
  det: Map<string, string>; canned: Map<string, string>;
  /** Fixed replies that send price rows before their own body (`quote_services`). */
  quoting: Set<string>;
};
async function loadTenant(slug: string): Promise<Tenant> {
  const t = await db.from('tenants').select('id, default_locale, live_revision_id').eq('slug', slug).single();
  if (t.error) throw new Error(`${slug}: ${t.error.message}`);
  const id = String(t.data['id']);
  if (t.data['live_revision_id'] === null) throw new Error(`${slug}: not published on this replica`);
  const c = await db.from('tenant_channels').select('id, external_id, app_slug, delivery_mode, token_status, comment_delivery_mode')
    .eq('tenant_id', id).eq('provider', 'facebook_page').single();
  if (c.error) throw new Error(`${slug} channel: ${c.error.message}`);
  const live = c.data['delivery_mode'] === 'live' && c.data['comment_delivery_mode'] === 'live';
  const shadow = c.data['delivery_mode'] === 'shadow' && c.data['comment_delivery_mode'] === 'shadow';
  if (c.data['token_status'] !== 'active' || !(live || (shadow && SHADOW_TESTERS))) {
    throw new Error(`${slug}: its replica channel must be live (messages and comments) with an active token status, `
      + 'or shadow for both with --shadow-testers');
  }
  const d = await db.from('deterministic_replies').select('intent, body, quote_services').eq('tenant_id', id);
  const k = await db.from('canned_responses').select('kind, body, locale').eq('tenant_id', id).eq('locale', String(t.data['default_locale']));
  if (d.error || k.error) throw new Error(`${slug}: rows unreadable`);
  return {
    slug, id, channelId: String(c.data['id']), pageId: String(c.data['external_id']), shadow,
    appSlug: String(c.data['app_slug'] ?? 'dalatech'),
    det: new Map((d.data ?? []).map((r) => [String(r['intent']), String(r['body'])])),
    canned: new Map((k.data ?? []).map((r) => [String(r['kind']), String(r['body'])])),
    quoting: new Set((d.data ?? []).filter((r) => Array.isArray(r['quote_services']) && r['quote_services'].length > 0).map((r) => String(r['intent']))),
  };
}

// ---- the recorders -------------------------------------------------------------------------
type Sent = { tenantId: string; recipientId: string; body: string };
const sent: Sent[] = [];
const publicReplies: { tenantId: string; commentId: string; body: string }[] = [];
const privateReplies: { tenantId: string; commentId: string; body: string }[] = [];
const complaints: { tenantId: string; commentId: string }[] = [];
const needsPerson: { tenantId: string; reason: string }[] = [];
let modelCalls = new Map<string, number>();
const logs: string[] = [];

function effects(now: Date): WorkerEffects {
  return {
    db, now,
    verifySignature: async () => true,
    graphVersionDefault: () => 'v21.0',
    alertStandby: async () => {},
    alertDeliveryExhausted: async () => {},
    generateReply: (a) => {
      const deps = buildDeps({
        db, tenantId: a.tenantId, channelId: a.channelId, conversationId: a.conversationId,
        cacheMode: a.ctx.cacheMode, inboundExternalId: a.inboundExternalId, reservation: a.reservation, now,
      });
      return handleReception({
        ...deps,
        // The stub model: counted, and refuses, so the tenant's pinned line answers. No spend.
        callModel: async () => {
          modelCalls.set(a.tenantId, (modelCalls.get(a.tenantId) ?? 0) + 1);
          return { kind: 'terminal', reason: 'refusal', detail: 'branch-parity stub' };
        },
      }, {
        customerMessage: a.customerMessage,
        customerAttachments: a.customerAttachments,
        customerSentPhoto: a.customerSentPhoto,
        ...(a.photoQuestionState === null ? {} : { photoQuestionState: a.photoQuestionState }),
        history: a.history, eventAt: a.eventAt, now,
        promptStable: a.ctx.promptStable, promptVolatile: a.promptVolatile,
        modelId: MODEL_REGISTRY.reception, cacheMode: a.ctx.cacheMode, timeoutMs: RECEPTION_UPSTREAM_TIMEOUT_MS,
        rules: a.ctx.rules, deterministic: a.ctx.deterministic, days: a.ctx.days,
        historyState: { known: true, empty: a.historyEmpty },
        canned: a.ctx.canned, tenantGuard: a.ctx.tenantGuard, cannedLabel: SECTION_LABELS.canned,
        serviceNames: servicesFromPrefix(a.ctx.promptStable, SECTION_LABELS.priceList),
        serviceAliases: a.ctx.serviceAliases, spellings: a.ctx.spellings,
        depositRows: sectionRows(a.ctx.promptStable, SECTION_LABELS.deposits),
        faqAnswers: faqAnswersFromPrefix(a.ctx.promptStable, SECTION_LABELS.faqs),
        branches: a.ctx.branches, cannedHash: a.ctx.cannedHash, fallbackLine: a.ctx.fallbackLine,
        noInbox: false, ownSiteHosts: [], complaintRules: a.ctx.complaintRules, sales: a.ctx.sales,
        replyStyle: a.ctx.replyStyle,
      });
    },
    // The production delivery (claim bookkeeping, `markSent`, so the reply is in the next
    // turn's history), with only the credential and the Graph call replaced by a recorder.
    deliver: (a) => deliverOutbound({
      ...buildDeliverDeps({
        db, tenantId: a.tenantId, channelId: a.channelId, outboundId: a.outboundId, attempts: a.attempts, now,
        ...(a.tokenChannelId === undefined ? {} : { tokenChannelId: a.tokenChannelId }),
      }),
      loadSecret: async () => ({ ok: true, secret: 'replica-recorder', kekVersion: 2, status: 'active' }),
      send: async (input) => {
        sent.push({ tenantId: a.tenantId, recipientId: a.recipientId, body: input.text });
        return { outcome: 'sent', providerMessageId: `m_${randomUUID()}`, recipientId: a.recipientId };
      },
      recordSecretOk: async () => ({ ok: true }),
    }, a),
    showTyping: async () => {},
    flagQuality: async () => {},
    salesShadow: async () => {},
    log: (level, event, fields) => { if (level !== 'info') logs.push(`${level} ${event} ${JSON.stringify(fields ?? {})}`); },
    replyToComment: async (a) => {
      publicReplies.push({ tenantId: a.tenantId, commentId: a.commentId, body: a.body });
      return { outcome: 'sent', providerCommentId: `${a.commentId}_r` };
    },
    sendPrivateReply: async (a) => {
      privateReplies.push({ tenantId: a.tenantId, commentId: a.commentId, body: a.body });
      return { outcome: 'sent', providerMessageId: `m_${randomUUID()}` };
    },
    lookupComment: async () => ({ tagsPerson: false, postCreatedAt: new Date(Date.now() - 86_400_000), problems: [] }),
    alertComplaint: async (a) => { complaints.push({ tenantId: a.tenantId, commentId: a.commentId }); },
    alertCeilingReached: async () => 'stub',
    alertMediaHandoff: async () => {},
    alertCannedStale: async () => 'stub',
    alertNeedsPerson: async (a) => { needsPerson.push({ tenantId: a.tenantId, reason: String(a.reason) }); return true; },
  } as WorkerEffects;
}

/** One webhook entry, through routing and the worker, exactly as Meta's POST would go. */
async function deliverEntry(t: Tenant, entry: MetaEntry): Promise<void> {
  const jobs: { eventId: number; tenantId: string; channelId: string }[] = [];
  const outcome = await handleMetaEntry({
    db,
    enqueue: async (j) => { jobs.push({ eventId: j.eventId, tenantId: j.tenantId, channelId: j.channelId }); return { ok: true } as never; },
    log: (level, event, fields) => { if (level !== 'info') logs.push(`${level} ${event} ${JSON.stringify(fields ?? {})}`); },
  }, { provider: 'facebook_page', entry, index: 0, matchedAppSlug: t.appSlug });
  if (outcome.outcome !== 'queued') throw new Error(`${t.slug}: entry not queued (${outcome.outcome})`);
  for (const j of jobs) {
    const r = await runReceptionJob(effects(new Date()), { rawBody: JSON.stringify(j), signature: 'stub' });
    if (r.status !== 200) throw new Error(`${t.slug}: worker answered ${r.status} ${JSON.stringify(r.body)}`);
  }
}

const dm = (t: Tenant, psid: string, message: Record<string, unknown>): MetaEntry => {
  const ts = Date.now();
  return {
    id: t.pageId, time: ts,
    messaging: [{ sender: { id: psid }, recipient: { id: t.pageId }, timestamp: ts, message: { mid: `m_${randomUUID()}`, ...message } }],
  } as MetaEntry;
};
const comment = (t: Tenant, fromId: string, text: string): MetaEntry => {
  const s = Math.floor(Date.now() / 1000);
  const postId = `${t.pageId}_${100000 + Math.floor(Math.random() * 899999)}`;
  return {
    id: t.pageId, time: Date.now(),
    changes: [{ field: 'feed', value: {
      item: 'comment', verb: 'add', comment_id: `${postId}_${randomUUID().slice(0, 8)}`, post_id: postId, parent_id: postId,
      from: { id: fromId, name: 'Харилцагч' }, message: text, created_time: s,
    } }],
  } as unknown as MetaEntry;
};

// ---- the scenarios -------------------------------------------------------------------------
type Expect =
  | { det: string } | { canned: string } | { model: true } | { nothing: true }
  | { otherBranch: true } | { comment: 'reply' | 'escalate' | 'silent' } | { person: true }
  /** The reply carries this text (a price the platform renders from the rows). */
  | { contains: string };
type Step = { text?: string; attachments?: unknown[]; waitMs?: number };
type Scenario = { name: string; steps: Step[]; comment?: string; expect: (t: Tenant, other: Tenant) => Expect };

const IMG = { type: 'image', payload: { url: 'https://scontent.xx.fbcdn.net/v/t1.15752-9/hair.jpg' } };
const same = (e: Expect) => () => e;
const SCENARIOS: Scenario[] = [
  { name: 'greeting', steps: [{ text: 'Сайн байна уу' }], expect: same({ det: 'greeting' }) },
  { name: 'Latin greeting', steps: [{ text: 'sn bnuu' }], expect: same({ det: 'greeting' }) },
  { name: 'thanks', steps: [{ text: 'баярлалаа' }], expect: same({ det: 'thanks' }) },
  { name: 'ok', steps: [{ text: 'Ok' }], expect: same({ det: 'acknowledgement' }) },
  { name: 'like as first message', steps: [{ attachments: [{ type: 'image', payload: { url: 'https://scontent.xx.fbcdn.net/like.png', sticker_id: Number(LIKE_STICKER_IDS[0]) } }] }],
    expect: same({ det: 'like_welcome' }) },
  { name: 'who are you', steps: [{ text: 'ci henbe' }], expect: same({ det: 'assistant_who' }) },
  { name: 'who made you', steps: [{ text: 'cmg hen hiisen be' }], expect: same({ det: 'assistant_maker' }) },
  { name: 'price, no service', steps: [{ text: 'Үнэ' }], expect: same({ det: 'price_which_service' }) },
  { name: 'address', steps: [{ text: 'Хаяг хаана вэ' }], expect: same({ det: 'address' }) },
  { name: 'phone', steps: [{ text: 'Утас хэд вэ' }], expect: same({ det: 'salon_phone' }) },
  { name: 'branch count', steps: [{ text: 'Танай хэдэн салбартай вэ?' }], expect: same({ det: 'branch_count' }) },
  { name: 'the other branch', steps: [{ text: '__OTHER_BRANCH__ салбар хаана байдаг вэ?' }], expect: same({ otherBranch: true }) },
  { name: 'own branch by name', steps: [{ text: '__OWN_BRANCH__ салбар хаана байдаг вэ?' }], expect: same({ det: 'address' }) },
  { name: 'deposit deducted', steps: [{ text: 'Урьдчилгаа төлбөр үйлчилгээний үнээс хасагдах уу' }], expect: same({ det: 'deposit_deducted' }) },
  { name: 'deposit required', steps: [{ text: 'Заавал эхлээд урьдчилгаа хийх үү?' }], expect: same({ det: 'deposit_required' }) },
  { name: 'loan apps', steps: [{ text: 'Зээлийн апп-аар төлж болох уу' }], expect: same({ det: 'loan_apps' }) },
  { name: 'stylist level', steps: [{ text: 'SPECIAL үсчин' }], expect: same({ det: 'stylist_tier' }) },
  { name: 'dye brand (hand-off)', steps: [{ text: 'Ямар брэндийн будаг хэрэглэдэг вэ' }], expect: same({ det: 'dye_brand' }) },
  { name: 'colour lift', steps: [{ text: 'ungu gargalt hed ve' }], expect: same({ det: 'colour_lift' }) },
  { name: "women's treatment perm", steps: [{ text: 'Эмэгтэй эмчилгээний хими хийдэг үү' }], expect: same({ det: 'treatment_perm_women' }) },
  { name: 'perm types', steps: [{ text: 'usnii himi' }], expect: same({ det: 'perm_types' }) },
  { name: 'nails (not offered)', steps: [{ text: 'Маникюр хийдэг үү?' }], expect: same({ canned: 'refusal_service_unavailable' }) },
  { name: 'photo alone', steps: [{ attachments: [IMG] }], expect: same({ canned: 'photo_price_question' }) },
  { name: 'photo, then «how much» after the question', steps: [{ attachments: [IMG] }, { text: 'hed ve', waitMs: 31_000 }],
    expect: same({ canned: 'handover_notice' }) },
  // «Tara perm урт» just after the photo question names one service: it reaches the model (as
  // Яармаг's three «Tara perm урт» reply cases do), never the hand-off without asking.
  { name: 'photo, then a service at once', steps: [{ attachments: [IMG] }, { text: 'Tara perm урт' }],
    expect: same({ model: true }) },
  { name: 'like after an answer', steps: [{ text: 'Хаяг хаана вэ' }, { waitMs: 2_000, attachments: [{ type: 'image', payload: { url: 'https://scontent.xx.fbcdn.net/like.png', sticker_id: Number(LIKE_STICKER_IDS[0]) } }] }],
    expect: same({ det: 'acknowledgement' }) },
  { name: 'reel link', steps: [{ text: 'https://www.facebook.com/share/r/1AbCdEfGh/' }], expect: same({ canned: 'reel_price_question' }) },
  { name: 'video attachment', steps: [{ attachments: [{ type: 'video', payload: { url: 'https://video.xx.fbcdn.net/v/clip.mp4' } }] }],
    expect: same({ canned: 'reel_price_question' }) },
  { name: 'voice message', steps: [{ attachments: [{ type: 'audio', payload: { url: 'https://cdn.fbsbx.com/v/audio.mp4' } }] }],
    expect: same({ canned: 'voice_received' }) },
  { name: 'asks for a person', steps: [{ text: 'Ажилтантай холбогдмоор байна' }], expect: same({ person: true }) },
  { name: 'asks for a person, Latin', steps: [{ text: 'huntei yrimaar bn' }], expect: same({ person: true }) },
  { name: "men's colour lift", steps: [{ text: 'eregtei hun ungu gargalt hed ve' }], expect: same({ det: 'colour_lift_men' }) },
  { name: "the other branch's phone", steps: [{ text: '__OTHER_BRANCH__ салбарын утас?' }], expect: same({ otherBranch: true }) },
  // A men's-cut price reaches the model in both branches; what it may quote is the branch's own
  // price list (Парк Од: «Эрэгтэй тайралт: 69,000₮» only, 2026-10-08) and its allowed numbers.
  { name: "men's cut price", steps: [{ text: 'Эрэгтэй тайралт хэд вэ?' }], expect: same({ model: true }) },
  { name: 'a question the rows cannot answer', steps: [{ text: 'Та нар ямар шампунь зардаг вэ, хэдэн төрөл байгаа вэ?' }], expect: same({ model: true }) },
  // comments
  { name: 'comment: price question', steps: [], comment: 'Үнэ хэд вэ?', expect: same({ comment: 'reply' }) },
  { name: 'comment: where are you', steps: [], comment: 'Хаана байрладаг вэ?', expect: same({ comment: 'reply' }) },
  { name: 'comment: complaint', steps: [], comment: 'Маш муу үйлчилгээ, их удаан хүлээлгэсэн', expect: same({ comment: 'escalate' }) },
  { name: 'comment: praise', steps: [], comment: 'Гоё байна 😍', expect: same({ comment: 'silent' }) },
  { name: 'comment: advert', steps: [], comment: 'Хямдралтай цүнх зарна, 99112233 утсаар залгаарай, ердөө 50,000₮', expect: same({ comment: 'silent' }) },
];

// ---- run -----------------------------------------------------------------------------------
const a = await loadTenant(SLUG_A);
const b = await loadTenant(SLUG_B);
const branchName = (t: Tenant): string => BRANCH[t.slug]!;
// What one branch must never say about the other outside the row that names it on purpose.
// Its phones, address, map link and Page link (as the other branch's own row about it types
// them), its active hairdressers' names, and the Cyrillic names customers call them by
// (config/branch-groups.json `staff_aliases`, the branch gate's own list). Branch NAMES are not
// tokens: both branches' `branch_count` names both on purpose.
const groups = JSON.parse(readFileSync(new URL('../../config/branch-groups.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const aliasesOf = (slug: string): string[] => {
  for (const g of Object.values(groups)) {
    const a = (g as { staff_aliases?: Record<string, string[]> })?.staff_aliases?.[slug];
    if (Array.isArray(a)) return a;
  }
  return [];
};
async function foreignTokens(t: Tenant, other: Tenant): Promise<string[]> {
  const cp = await db.from('contact_points').select('kind, value').eq('tenant_id', t.id);
  const st = await db.from('staff_members').select('name').eq('tenant_id', t.id).eq('active', true);
  if (cp.error || st.error) throw new Error(`${t.slug}: contact or staff rows unreadable`);
  const out: string[] = [];
  for (const r of cp.data ?? []) {
    if (r['kind'] === 'phone') out.push(...String(r['value']).split(/[,\s]+/).filter((p) => /^\d{8}$/.test(p)));
    if (r['kind'] === 'address' || r['kind'] === 'maps_url') out.push(String(r['value']));
  }
  // t's Page link, as the other branch's row about t gives it.
  const page = /https:\/\/www\.facebook\.com\/\S+/u.exec(other.det.get(otherBranchIntent(other)) ?? '')?.[0];
  if (page !== undefined) out.push(page);
  for (const r of st.data ?? []) out.push(String(r['name']));
  out.push(...aliasesOf(t.slug));
  return out.filter((x) => x.trim() !== '').map((x) => x.normalize('NFC').toLowerCase());
}
/** A reply as the leak check reads it: NFC, lower case, a phone's spaces and +976 folded away. */
const folded = (body: string): string => body.normalize('NFC').toLowerCase()
  .replace(/\+976\s*/gu, '').replace(/(?<=\d)[\s-](?=\d)/gu, '');
const otherBranchIntent = (t: Tenant): string => (t.det.has('park_od_branch') ? 'park_od_branch' : 'yarmag_branch');
const foreignOfA = await foreignTokens(a, b);
const foreignOfB = await foreignTokens(b, a);

// No reply of a branch carries the other branch's details, except the one row that names it.
function leakCheck(t: Tenant, label: string, bodies: readonly string[]): void {
  const foreign = t === a ? foreignOfB : foreignOfA;
  const allowedOther = t.det.get(otherBranchIntent(t));
  for (const body of bodies) {
    if (body === allowedOther) continue;
    const f = folded(body);
    for (const tok of foreign) if (f.includes(tok)) fail(`${label}: reply carries the other branch's «${tok}»`);
  }
}

let failures = 0;
const fail = (s: string) => { failures++; console.log(`  FAIL ${s}`); };

for (const sc of SCENARIOS) {
  const results: Record<string, string[]> = {};
  const usedModel: Record<string, boolean> = {};
  await Promise.all([a, b].map(async (t) => {
    const other = t === a ? b : a;
    const psid = `parity_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const before = { sent: sent.length, pub: publicReplies.length, priv: privateReplies.length, comp: complaints.length, np: needsPerson.length };
    modelCalls.set(t.id, 0);
    if (t.shadow) {
      const cur = await db.from('tenant_channels').select('test_sender_ids').eq('id', t.channelId).single();
      if (cur.error) throw new Error(`${t.slug}: test_sender_ids unreadable: ${cur.error.message}`);
      const ids = Array.isArray(cur.data['test_sender_ids']) ? (cur.data['test_sender_ids'] as string[]) : [];
      const up = await db.from('tenant_channels').update({ test_sender_ids: [...ids, psid] }).eq('id', t.channelId);
      if (up.error) throw new Error(`${t.slug}: test_sender_ids not written: ${up.error.message}`);
    }
    if (sc.comment !== undefined) {
      await deliverEntry(t, comment(t, psid, sc.comment));
    } else {
      for (const step of sc.steps) {
        if (step.waitMs !== undefined) await new Promise((r) => setTimeout(r, step.waitMs));
        const text = step.text?.replace('__OTHER_BRANCH__', branchName(other)).replace('__OWN_BRANCH__', branchName(t));
        await deliverEntry(t, dm(t, psid, { ...(text === undefined ? {} : { text }), ...(step.attachments === undefined ? {} : { attachments: step.attachments }) }));
      }
    }
    const mine = sent.slice(before.sent).filter((s) => s.tenantId === t.id && s.recipientId === psid).map((s) => s.body);
    usedModel[t.slug] = (modelCalls.get(t.id) ?? 0) > 0;
    const exp = sc.expect(t, other);
    const label = `${sc.name} [${t.slug}]`;
    if ('comment' in exp) {
      const pub = publicReplies.slice(before.pub).filter((r) => r.tenantId === t.id);
      const priv = privateReplies.slice(before.priv).filter((r) => r.tenantId === t.id);
      const comp = complaints.slice(before.comp).filter((r) => r.tenantId === t.id);
      results[t.slug] = [`public:${pub.length} private:${priv.length} escalated:${comp.length}`];
      leakCheck(t, label, [...pub, ...priv].map((r) => r.body));
      if (exp.comment === 'reply') {
        if (pub.length !== 1 || pub[0]!.body !== t.canned.get('comment_public_reply')) fail(`${label}: expected the public reply line, got ${JSON.stringify(pub.map((p) => p.body))}`);
        if (priv.length !== 1 || priv[0]!.body !== t.canned.get('comment_private_reply')) fail(`${label}: expected the private reply line, got ${JSON.stringify(priv.map((p) => p.body))}`);
      } else if (exp.comment === 'escalate') {
        if (pub.length + priv.length !== 0 || comp.length !== 1) fail(`${label}: expected silence and one alert, got ${results[t.slug]![0]}`);
      } else if (pub.length + priv.length + comp.length !== 0) {
        fail(`${label}: expected nothing at all, got ${results[t.slug]![0]}`);
      }
      return;
    }
    results[t.slug] = mine;
    const last = mine[mine.length - 1];
    let want: string | undefined;
    if ('det' in exp) want = t.det.get(exp.det);
    else if ('canned' in exp) want = t.canned.get(exp.canned);
    else if ('otherBranch' in exp) want = t.det.get(otherBranchIntent(t));
    if ('contains' in exp) {
      if (!(last ?? '').includes(exp.contains)) fail(`${label}: expected a reply with «${exp.contains}», got ${JSON.stringify(last?.slice(0, 120))}`);
      if (usedModel[t.slug]) fail(`${label}: the model was asked for a price the rows carry`);
    } else if ('person' in exp) {
      // A person is asked for: the tenant's own hand-off line, and the founder is told.
      const told = needsPerson.slice(before.np).filter((n) => n.tenantId === t.id);
      if (last !== t.canned.get('handoff')) fail(`${label}: expected the hand-off line, got ${JSON.stringify(last?.slice(0, 80))}`);
      if (told.length === 0) fail(`${label}: expected a needs-person alert, none was raised`);
    } else if ('model' in exp) {
      if (!usedModel[t.slug]) fail(`${label}: expected the model to be asked, it was not (got ${JSON.stringify(last)})`);
      if (last !== t.canned.get('handoff')) fail(`${label}: after the model refused, expected the hand-off line, got ${JSON.stringify(last)}`);
    } else if ('nothing' in exp) {
      if (mine.length !== 0) fail(`${label}: expected no reply, got ${JSON.stringify(mine)}`);
    } else if (want === undefined) {
      fail(`${label}: the tenant has no such row (${JSON.stringify(exp)})`);
    } else if (last !== want && !('det' in exp && t.quoting.has(exp.det) && (last ?? '').endsWith(`\n\n${want}`))) {
      // A fixed reply that quotes services (`quote_services`) sends the price rows, a blank
      // line, then its own body; anything else must be the row's bytes exactly.
      fail(`${label}: expected ${JSON.stringify(want.slice(0, 80))}, got ${JSON.stringify(last?.slice(0, 80))}`);
    }
    leakCheck(t, label, mine);
  }));
  if (usedModel[a.slug] !== usedModel[b.slug]) fail(`${sc.name}: one branch asked the model and the other did not`);
  console.log(`${sc.name}: ${a.slug} ${JSON.stringify(results[a.slug]?.map((s) => s.slice(0, 60)))} | ${b.slug} ${JSON.stringify(results[b.slug]?.map((s) => s.slice(0, 60)))}`);
}

const unexpected = logs.filter((l) => l.startsWith('error'));
if (unexpected.length > 0) {
  console.log(`\n${unexpected.length} error log line(s):`);
  for (const l of unexpected.slice(0, 20)) console.log(`  ${l.slice(0, 300)}`);
}
console.log(`\n${SCENARIOS.length} scenarios × 2 tenants: ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
