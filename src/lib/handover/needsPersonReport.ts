/**
 * The daily report's line on chats that needed a person (founder, 2026-10-02; proposal
 * `docs/proposals/tara-staff-handoff.md`, option D).
 *
 * For each tenant: how many chats paged the founder yesterday as needing a person (D-158:
 * complaint, request for a person, voice message, hand-off line), and how many of them a
 * member of staff has replied to since the page. The founder reads whether the hand-off is
 * closing, which a page alone cannot show: on 2026-10-02 it was 0 of 8 for Tara.
 *
 * "Staff replied" is read from the conversation: a person's reply in the Page inbox moves the
 * thread to `human` with source `echo` and stamps the time (`handover/record.ts`, live
 * channels only). So a chat counts as answered when its thread is `human` by `echo` at or
 * after its first page. Two limits, said here rather than hidden:
 * - a staff reply later overwritten (the bot's take-back, D-164, or a Meta hand-over) is not
 *   counted, so the number can undercount;
 * - a phone call to the customer is not seen at all.
 *
 * `reclaim_sent` pages are not counted: they are the bot taking a chat back, not a customer
 * waiting. Only chats on LIVE channels are counted (a staff reply is seen only there). The
 * reply is read when the report runs (00:05), so a chat paged at 23:50 has had 15 minutes:
 * the line says «by report time». Read-only; never throws; an unreadable read prints
 * UNREADABLE, never zero.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { NEEDS_PERSON_ALERT_KIND } from './needsPerson.ts';

export type NeedsPersonSummary =
  | { ok: true; byTenant: Array<{ tenant: string; chats: number; answered: number; notCounted?: number }>; capped: boolean }
  | { ok: false; detail: string };

/** More pages than this in one day is not a day to count precisely: the line says ≥. */
const MAX_ALERTS = 1000;
const COUNTED = new Set(['complaint', 'handoff', 'voice']);

/** `needs_person:<conversation>:<reason>:<day>` → conversation and reason, or null. */
export function parseNeedsPersonKey(key: string): { conversationId: string; reason: string } | null {
  const parts = key.split(':');
  if (parts.length < 4 || parts[0] !== 'needs_person' || parts[1] === '' || parts[2] === '') return null;
  return { conversationId: parts[1] as string, reason: parts[2] as string };
}

export async function readNeedsPersonLoop(
  db: SupabaseClient, input: { since: string; until: string },
): Promise<NeedsPersonSummary> {
  try {
    const { data, error } = await db.from('alerts')
      .select('tenant_id, dedup_key, at')
      .eq('kind', NEEDS_PERSON_ALERT_KIND)
      .gte('at', input.since)
      .lt('at', input.until)
      .order('at', { ascending: true })
      .limit(MAX_ALERTS);
    if (error) return { ok: false, detail: `alerts unreadable: ${error.message}` };
    const rows = Array.isArray(data) ? data as Array<Record<string, unknown>> : [];
    // The FIRST page per conversation: a staff reply after it answers the chat.
    const first = new Map<string, { tenantId: string; at: number }>();
    for (const r of rows) {
      const k = parseNeedsPersonKey(String(r['dedup_key'] ?? ''));
      if (k === null || !COUNTED.has(k.reason)) continue;
      const at = new Date(String(r['at'])).getTime();
      if (Number.isNaN(at) || first.has(k.conversationId)) continue;
      first.set(k.conversationId, { tenantId: String(r['tenant_id'] ?? ''), at });
    }
    const answered = new Set<string>();
    const channelOf = new Map<string, string>();
    const ids = [...first.keys()];
    for (let i = 0; i < ids.length; i += 100) {
      const { data: convs, error: cErr } = await db.from('conversations')
        .select('id, channel_id, thread_control, thread_control_source, thread_control_at')
        .in('id', ids.slice(i, i + 100));
      if (cErr) return { ok: false, detail: `conversations unreadable: ${cErr.message}` };
      for (const c of Array.isArray(convs) ? convs as Array<Record<string, unknown>> : []) {
        const id = String(c['id']);
        channelOf.set(id, String(c['channel_id'] ?? ''));
        const at = new Date(String(c['thread_control_at'] ?? '')).getTime();
        const page = first.get(id);
        if (page !== undefined && c['thread_control'] === 'human' && c['thread_control_source'] === 'echo'
          && !Number.isNaN(at) && at >= page.at) answered.add(id);
      }
    }
    // A staff reply moves the thread only on a LIVE channel (D-080), so elsewhere «0 answered»
    // would be a blind spot dressed as a measurement. Those chats are left out of the line.
    const channels = [...new Set(channelOf.values())].filter((c) => c !== '');
    const live = new Set<string>();
    if (channels.length > 0) {
      const { data: chs, error: chErr } = await db.from('tenant_channels').select('id, delivery_mode').in('id', channels);
      if (chErr) return { ok: false, detail: `tenant_channels unreadable: ${chErr.message}` };
      for (const c of Array.isArray(chs) ? chs as Array<Record<string, unknown>> : []) {
        if (c['delivery_mode'] === 'live') live.add(String(c['id']));
      }
    }
    // Left out, but never silently: a chat whose channel is not live NOW (or whose row is gone)
    // is named as not counted, so «none» means no page at all.
    const notCounted = new Map<string, number>();
    for (const id of ids) {
      if (live.has(channelOf.get(id) ?? '')) continue;
      const t = first.get(id)?.tenantId ?? '';
      notCounted.set(t, (notCounted.get(t) ?? 0) + 1);
      first.delete(id);
    }
    const tenantIds = [...new Set([...[...first.values()].map((v) => v.tenantId), ...notCounted.keys()])];
    const names = new Map<string, string>();
    if (tenantIds.length > 0) {
      const { data: ts, error: tErr } = await db.from('tenants').select('id, display_name').in('id', tenantIds);
      // A name that cannot be read is printed as the id, never dropped.
      if (!tErr) for (const t of Array.isArray(ts) ? ts as Array<Record<string, unknown>> : []) names.set(String(t['id']), String(t['display_name'] ?? t['id']));
    }
    const per = new Map<string, { chats: number; answered: number; notCounted?: number }>();
    for (const [id, v] of first) {
      const cur = per.get(v.tenantId) ?? { chats: 0, answered: 0 };
      cur.chats += 1;
      if (answered.has(id)) cur.answered += 1;
      per.set(v.tenantId, cur);
    }
    for (const [t, n] of notCounted) per.set(t, { ...(per.get(t) ?? { chats: 0, answered: 0 }), notCounted: n });
    return {
      ok: true, capped: rows.length >= MAX_ALERTS,
      byTenant: [...per].map(([id, v]) => ({ tenant: names.get(id) ?? id, ...v })),
    };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/** The report line. Printed on a clean day too («none»); unreadable is UNREADABLE, never zero. */
export function needsPersonLine(s: NeedsPersonSummary): string {
  if (!s.ok) return `Chats that needed a person (yesterday): UNREADABLE — ${s.detail}`;
  if (s.byTenant.length === 0) return 'Chats that needed a person (yesterday): none';
  const at = s.capped ? '≥' : '';
  // By count, then by name in code-point order (D-026): never locale collation.
  const ordered = [...s.byTenant].sort((x, y) => y.chats - x.chats || (x.tenant < y.tenant ? -1 : x.tenant > y.tenant ? 1 : 0));
  return `Chats that needed a person (yesterday): ${ordered.map((r) => `${r.tenant} ${at}${r.chats}, staff replied to ${r.answered} by report time`
    + ((r.notCounted ?? 0) > 0 ? `, ${r.notCounted} not counted (channel not live)` : '')).join('; ')}`;
}
