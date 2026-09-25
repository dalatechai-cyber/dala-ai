/**
 * The morning flaw report (D-120).
 *
 * Founder, 2026-09-24, first live day on Matrix: *"Every morning (09:00 Ulaanbaatar), send
 * me one Telegram message with yesterday's real conversations that look wrong: the customer
 * corrected the bot, repeated a question, or got a handoff, refusal or 'didn't understand'.
 * Show the customer's message and the bot's reply. Keep it short."*
 *
 * ## What counts, and why each is a property of the text
 *
 *  - **corrected** — the customer's NEXT message carries one of the tenant's own correction
 *    words (its `on_correction` row's stems: «биш», «буруу», «bish»…). The reply before it is
 *    the one being corrected.
 *  - **repeated** — the customer asked the same thing again later in the conversation (the
 *    same words once folded, or three quarters of the same words). The FIRST answer is the
 *    one that did not satisfy.
 *  - **handoff** / **refusal** — the reply contains the tenant's reviewed `handoff` line or a
 *    `refusal_*` line whole. Correct refusals are listed too: the founder is the one who can
 *    tell a right refusal from a wrong one, and the list is short enough to read.
 *  - **didn't understand** — the reply says so in words («ойлгосонгүй», «тодруулж…»), or is
 *    the tenant's own correction reply.
 *
 * "Real" means SENT: a reply in `outbound_messages` with `state = 'sent'` to a customer
 * message written on the tenant's yesterday. A shadow draft reached nobody.
 *
 * ## It always sends, and it degrades loudly
 *
 * A clean day is one line per tenant, for the reason the digest gives: silence would mean
 * both "nothing was wrong" and "the report stopped". A tenant whose rows cannot be read is
 * reported UNREADABLE, never as zero.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { containsStem, wholeMessageKey } from '../mn/match.ts';
import { fold } from '../mn/text.ts';
import { tenantClock } from '../time/clock.ts';
import { loadLiveSnapshot } from '../prompt/publish.ts';
import { growSpellings } from './spellings.ts';
import { refusalMarkerFrom } from '../guard/apology.ts';
import { apologyStemsFrom } from '../guard/bookingApology.ts';
import { formerNameIn, internalMentionIn } from './leaks.ts';

export type FlawPair = {
  /** The first eight characters of the reply's id — what `mark_reply_wrong` takes. */
  ref: string;
  conversationId: string;
  customer: string;
  reply: string;
  at: Date;
  replyAt: Date;
};

export type LaterInbound = { conversationId: string; body: string; at: Date };

export type FlawSignals = {
  handoff: string | null;
  refusals: readonly { kind: string; body: string }[];
  /** The tenant's correction words (its `on_correction` rows' stems). */
  correctionStems: readonly string[];
  /** The tenant's own "I misunderstood" replies (its `on_correction` rows' bodies). */
  correctionBodies: readonly string[];
  /**
   * A refusal in the model's OWN words: the reply opens with the tenant's apology word
   * («Уучлаарай», from its handoff row) and its first sentence has a word ending the way
   * every reviewed refusal row does (`refusalMarkerFrom`, e.g. «…гүй»). Live, «cmg hen hiisen
   * be» got «Уучлаарай, энэ талаар хуваалцах боломжгүй.» — a refusal no row wrote.
   */
  apologyStems: readonly string[];
  refusalMarker: string | null;
  /** Names the tenant no longer uses (`tenants.former_names`, D-123). Optional: absent is none. */
  formerNames?: readonly string[];
  /** Approved text — reviewed lines, deterministic replies — cut out before the internal check. */
  approvedTexts?: readonly string[];
};

/**
 * The bot saying it did not understand. Matched over OUR reply, never the customer's text,
 * so the stem floor that protects customer matching does not apply; these are whole
 * inflected forms, not stems that could reach an unrelated word.
 */
export const NOT_UNDERSTOOD_STEMS: readonly string[] = ['ойлгосонгүй', 'ойлгоогүй', 'ойлгохгүй', 'тодруул', 'буруу ойлго'];

/** How long after a question a repeat still counts as the same question. */
export const REPEAT_WINDOW_MS = 24 * 60 * 60_000;

function sameQuestion(a: string, b: string): boolean {
  const ka = wholeMessageKey(a);
  const kb = wholeMessageKey(b);
  if (ka === '' || kb === '') return false;
  if (ka === kb) return true;
  const ta = new Set(ka.split(' '));
  const tb = new Set(kb.split(' '));
  if (ta.size < 2 || tb.size < 2) return false;
  const shared = [...ta].filter((t) => tb.has(t)).length;
  return shared / new Set([...ta, ...tb]).size >= 0.75;
}

export type Flaw = { pair: FlawPair; reasons: string[] };

/** Which of these pairs look wrong, and why. Pure. */
export function detectFlaws(
  pairs: readonly FlawPair[],
  inbound: readonly LaterInbound[],
  signals: FlawSignals,
): Flaw[] {
  const out: Flaw[] = [];
  const stems = signals.correctionStems.map((s) => fold(s).trim()).filter((s) => s !== '');
  for (const p of pairs) {
    const reasons: string[] = [];
    const later = inbound
      .filter((m) => m.conversationId === p.conversationId && m.at.getTime() > p.at.getTime())
      .sort((a, b) => a.at.getTime() - b.at.getTime());
    const next = later.find((m) => m.at.getTime() >= p.replyAt.getTime());
    if (next !== undefined && stems.some((s) => containsStem(next.body, s))) reasons.push('corrected');
    if (later.some((m) => m.at.getTime() - p.at.getTime() <= REPEAT_WINDOW_MS && sameQuestion(p.customer, m.body))) {
      reasons.push('repeated');
    }
    const reply = fold(p.reply);
    if (signals.handoff !== null && signals.handoff.trim() !== '' && reply.includes(fold(signals.handoff.trim()))) {
      reasons.push('handoff');
    }
    for (const r of signals.refusals) {
      if (r.body.trim() !== '' && reply.includes(fold(r.body.trim()))) reasons.push(`refusal (${r.kind.replace(/^refusal_/u, '')})`);
    }
    if (signals.refusalMarker !== null && !reasons.some((x) => x.startsWith('refusal') || x === 'handoff')) {
      const words = wholeMessageKey(p.reply.split(/[.!?…]/u)[0] ?? '').split(' ').filter((w) => w !== '');
      const opensSorry = words[0] !== undefined && signals.apologyStems.some((a) => words[0] === fold(a).replace(/[\p{P}]/gu, ''));
      const marker = fold(signals.refusalMarker);
      if (opensSorry && words.slice(1).some((w) => w.endsWith(marker))) reasons.push('refusal (own words)');
    }
    if (NOT_UNDERSTOOD_STEMS.some((s) => containsStem(p.reply, s))
      || signals.correctionBodies.some((b) => b.trim() !== '' && reply.includes(fold(b.trim())))) {
      reasons.push("didn't understand");
    }
    // Content, not conversation shape (D-123): «ci henbe» was answered «Матрикс» and no
    // signal above reads what a reply SAYS.
    const former = formerNameIn(p.reply, signals.formerNames ?? []);
    if (former !== null) reasons.push(`old name (${former})`);
    const internal = internalMentionIn(p.reply, p.customer, signals.approvedTexts ?? []);
    if (internal !== null) reasons.push(`internal (${internal})`);
    if (reasons.length > 0) out.push({ pair: p, reasons: [...new Set(reasons)] });
  }
  return out.sort((a, b) => a.pair.at.getTime() - b.pair.at.getTime());
}

/** At most this many conversations are shown per tenant; the rest are counted. */
export const MAX_ITEMS = 8;
const MAX_CUSTOMER_CP = 120;
const MAX_REPLY_CP = 160;

function clip(text: string, max: number): string {
  const cps = [...text.replace(/\s+/gu, ' ').trim()];
  return cps.length <= max ? cps.join('') : `${cps.slice(0, max - 1).join('')}…`;
}

export type TenantReport =
  | {
    ok: true; name: string; slug: string; date: string; replies: number; flaws: Flaw[];
    learned: { latin: string; cyrillic: string }[];
    asks: { latin: string; candidates: string[]; evidence: string[] }[];
    spellingsDetail?: string;
  }
  | { ok: false; name: string; detail: string };

/** One tenant's section. Pure. */
export function renderTenant(r: TenantReport): string {
  if (!r.ok) return `${r.name}: flaw report UNREADABLE — ${r.detail}`;
  const head = `${r.name} — ${r.date}: ${r.flaws.length} of ${r.replies} repl${r.replies === 1 ? 'y' : 'ies'} look${r.flaws.length === 1 ? 's' : ''} wrong.`;
  const lines = [head];
  for (const f of r.flaws.slice(0, MAX_ITEMS)) {
    lines.push('', `${f.pair.ref} · ${f.reasons.join(', ')}`,
      `C: ${clip(f.pair.customer, MAX_CUSTOMER_CP)}`, `B: ${clip(f.pair.reply, MAX_REPLY_CP)}`);
  }
  if (r.flaws.length > MAX_ITEMS) lines.push('', `…and ${r.flaws.length - MAX_ITEMS} more, not shown.`);
  if (r.learned.length > 0) {
    const shown = r.learned.slice(0, 6).map((l) => `${l.latin}→${l.cyrillic}`).join(', ');
    lines.push('', `Spellings learned: ${shown}${r.learned.length > 6 ? ` (+${r.learned.length - 6})` : ''}`);
  }
  if (r.spellingsDetail !== undefined) lines.push('', `Spellings UNREADABLE — ${r.spellingsDetail}`);
  for (const a of r.asks.slice(0, 3)) {
    const example = a.evidence[0] === undefined ? '' : ` «${clip(a.evidence[0], 60)}»`;
    lines.push('', `Settle: ${a.latin} = ${a.candidates.join(' or ')}?${example}`,
      `select set_spelling('${r.slug}', '${a.latin}', '${a.candidates[0] ?? ''}');`);
  }
  if (r.asks.length > 3) lines.push(`…and ${r.asks.length - 3} more spellings to settle.`);
  return lines.join('\n');
}

/** The whole message. Pure. */
export function renderFlawReport(reports: readonly TenantReport[]): string {
  const body = reports.map(renderTenant).join('\n\n');
  const any = reports.some((r) => r.ok && r.flaws.length > 0);
  const how = any ? "\n\nMark one wrong: select mark_reply_wrong('<ref>', '<the right reply>');" : '';
  return `Flaws\n\n${body || 'No tenant is live.'}${how}`;
}

/** The calendar day before `date`, both `YYYY-MM-DD`. Calendar arithmetic, no time zone. */
export function previousDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) - 1));
  return t.toISOString().slice(0, 10);
}

/** Look this far back, so a late-evening pair still sees the morning's corrections. */
const LOOKBACK_MS = 3 * 24 * 60 * 60_000;

async function tenantReport(
  db: SupabaseClient,
  t: { id: string; slug: string; name: string; timezone: string; formerNames: readonly string[] },
  now: Date,
): Promise<TenantReport> {
  const date = previousDate(tenantClock(now, t.timezone).date);
  const since = new Date(now.getTime() - LOOKBACK_MS).toISOString();
  const [msgs, replies, canned, det] = await Promise.all([
    db.from('messages').select('conversation_id, external_id, body, at')
      .eq('tenant_id', t.id).eq('direction', 'inbound').gte('at', since).order('at', { ascending: true }),
    db.from('outbound_messages').select('id, conversation_id, dedup_key, body, created_at')
      .eq('tenant_id', t.id).eq('kind', 'reply').eq('state', 'sent').gte('created_at', since),
    db.from('canned_responses').select('kind, body, reviewed_at').eq('tenant_id', t.id),
    db.from('deterministic_replies').select('body, enabled, match_mode, stems').eq('tenant_id', t.id),
  ]);
  for (const [name, res] of [['messages', msgs], ['outbound_messages', replies], ['canned_responses', canned],
    ['deterministic_replies', det]] as const) {
    if (res.error) return { ok: false, name: t.name, detail: `${name} unreadable: ${res.error.message}` };
  }
  const rows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v as Record<string, unknown>[] : []);

  const inbound = rows(msgs.data)
    .filter((r) => typeof r['body'] === 'string')
    .map((r) => ({
      conversationId: String(r['conversation_id']), externalId: String(r['external_id'] ?? ''),
      body: String(r['body']), at: new Date(String(r['at'])),
    }));
  const replyByKey = new Map(rows(replies.data).map((r) => [String(r['dedup_key'] ?? ''), r]));
  const pairs: FlawPair[] = [];
  for (const m of inbound) {
    if (tenantClock(m.at, t.timezone).date !== date) continue;
    const o = replyByKey.get(`in:${m.externalId}`);
    if (o === undefined) continue;
    pairs.push({
      ref: String(o['id']).slice(0, 8), conversationId: m.conversationId, customer: m.body,
      reply: String(o['body'] ?? ''), at: m.at, replyAt: new Date(String(o['created_at'])),
    });
  }

  const reviewed = rows(canned.data).filter((r) => r['reviewed_at'] !== null);
  const correction = rows(det.data).filter((r) => r['match_mode'] === 'on_correction' && r['enabled'] === true);
  const cannedRows = reviewed.map((r) => ({ kind: String(r['kind']), body: String(r['body'] ?? ''), reviewedAt: String(r['reviewed_at']) }));
  const apologyStems = apologyStemsFrom(cannedRows);
  const flaws = detectFlaws(pairs, inbound, {
    handoff: String(reviewed.find((r) => r['kind'] === 'handoff')?.['body'] ?? '') || null,
    refusals: reviewed.filter((r) => String(r['kind']).startsWith('refusal_'))
      .map((r) => ({ kind: String(r['kind']), body: String(r['body'] ?? '') })),
    correctionStems: correction.flatMap((r) => (Array.isArray(r['stems']) ? r['stems'].map(String) : [])),
    correctionBodies: correction.map((r) => String(r['body'] ?? '')),
    apologyStems,
    refusalMarker: refusalMarkerFrom(cannedRows, apologyStems),
    formerNames: t.formerNames,
    approvedTexts: [
      ...reviewed.map((r) => String(r['body'] ?? '')),
      ...rows(det.data).filter((r) => r['enabled'] === true).map((r) => String(r['body'] ?? '')),
    ],
  });

  // The list grows from yesterday's messages; the tenant's own text is what it may learn.
  const snapshot = await loadLiveSnapshot(db, { tenantId: t.id, channel: 'facebook_page' });
  const grown = await growSpellings(db, {
    tenantId: t.id,
    messages: inbound.filter((m) => tenantClock(m.at, t.timezone).date === date).map((m) => m.body),
    vocabularyTexts: [
      ...(snapshot.ok ? [snapshot.snapshot.promptStable] : []),
      ...reviewed.map((r) => String(r['body'] ?? '')),
      ...rows(det.data).map((r) => String(r['body'] ?? '')),
    ],
  });
  return {
    ok: true, name: t.name, slug: t.slug, date, replies: pairs.length, flaws,
    learned: grown.ok
      ? grown.added.filter((p) => p.status === 'settled' && p.cyrillic !== null)
        .map((p) => ({ latin: p.latin, cyrillic: p.cyrillic as string }))
      : [],
    asks: grown.ok ? grown.asks : [],
    ...(grown.ok ? {} : { spellingsDetail: grown.detail }),
  };
}

/**
 * Every live tenant's report, as one message. A tenant is live when any of its channels is:
 * a shadow tenant's drafts reached nobody, so there is nothing real to report.
 */
export async function buildFlawReport(db: SupabaseClient, now: Date): Promise<string> {
  const [tenants, channels] = await Promise.all([
    db.from('tenants').select('id, slug, display_name, timezone, former_names'),
    db.from('tenant_channels').select('tenant_id').eq('delivery_mode', 'live'),
  ]);
  if (tenants.error) return renderFlawReport([{ ok: false, name: 'All tenants', detail: `tenants unreadable: ${tenants.error.message}` }]);
  if (channels.error) return renderFlawReport([{ ok: false, name: 'All tenants', detail: `tenant_channels unreadable: ${channels.error.message}` }]);
  const live = new Set((Array.isArray(channels.data) ? channels.data : []).map((r) => String((r as Record<string, unknown>)['tenant_id'])));
  const reports: TenantReport[] = [];
  for (const raw of Array.isArray(tenants.data) ? tenants.data : []) {
    const r = raw as Record<string, unknown>;
    const id = String(r['id']);
    if (!live.has(id)) continue;
    const t = {
      id, slug: String(r['slug']), name: String(r['display_name'] ?? r['slug']), timezone: String(r['timezone']),
      formerNames: Array.isArray(r['former_names']) ? (r['former_names'] as unknown[]).map(String) : [],
    };
    try {
      reports.push(await tenantReport(db, t, now));
    } catch (err) {
      reports.push({ ok: false, name: t.name, detail: err instanceof Error ? err.message : String(err) });
    }
  }
  return renderFlawReport(reports.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
}
