/**
 * The booking tables (0082), through PostgREST. Every function returns a result, never throws,
 * and an unreadable answer is never read as "nothing there".
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { parseBookingConfig, type BookingConfig, type BookingMode } from './config.ts';
import type { Interval } from './slots.ts';

export type Fail = { ok: false; detail: string };
export type Ok<T> = { ok: true } & T;

const rec = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

export type ConfigRow =
  | { ok: true; present: false }
  | { ok: true; present: true; mode: BookingMode; valid: true; config: BookingConfig }
  | { ok: true; present: true; mode: BookingMode; valid: false; detail: string }
  | Fail;

export async function readConfig(db: SupabaseClient, tenantId: string): Promise<ConfigRow> {
  const { data, error } = await db.from('booking_config').select('mode, config').eq('tenant_id', tenantId).maybeSingle();
  if (error) return { ok: false, detail: `booking_config unreadable: ${error.message}` };
  if (data === null) return { ok: true, present: false };
  const r = rec(data);
  const mode = r['mode'] === 'test' || r['mode'] === 'live' ? r['mode'] : 'off';
  const parsed = parseBookingConfig(r['config']);
  return parsed.ok
    ? { ok: true, present: true, mode, valid: true, config: parsed.config }
    : { ok: true, present: true, mode, valid: false, detail: parsed.detail };
}

/** What a confirmation names: the tenant's own rows, read once per job. */
export type TenantFacts = { timezone: string; displayName: string; branch: string; address: string | null; bookingUrl: string | null };

/**
 * «Tara Salon — Яармаг» → «Яармаг»: the branch label of a branch tenant's display name (the
 * onboarding convention «Brand — Branch», dali.md L2). A name with no label: the whole name.
 */
export function branchLabel(displayName: string): string {
  const parts = displayName.split(' — ');
  return (parts.length > 1 ? parts[parts.length - 1] as string : displayName).trim();
}

export async function readTenantFacts(db: SupabaseClient, tenantId: string): Promise<Ok<{ facts: TenantFacts }> | Fail> {
  const [t, cp, bk] = await Promise.all([
    db.from('tenants').select('timezone, display_name').eq('id', tenantId).maybeSingle(),
    db.from('contact_points').select('kind, value').eq('tenant_id', tenantId).eq('kind', 'address'),
    db.from('tenant_booking').select('booking_url').eq('tenant_id', tenantId).maybeSingle(),
  ]);
  if (t.error || t.data === null) return { ok: false, detail: `tenant unreadable: ${t.error?.message ?? 'no row'}` };
  if (cp.error) return { ok: false, detail: `contact_points unreadable: ${cp.error.message}` };
  if (bk.error) return { ok: false, detail: `tenant_booking unreadable: ${bk.error.message}` };
  const tr = rec(t.data);
  const addresses = (Array.isArray(cp.data) ? cp.data : []).map((r) => String(rec(r)['value'] ?? '').trim()).filter((v) => v !== '');
  const displayName = String(tr['display_name'] ?? '');
  const url = rec(bk.data)['booking_url'];
  return {
    ok: true,
    facts: {
      timezone: String(tr['timezone'] ?? ''),
      displayName,
      branch: branchLabel(displayName),
      // One address row: it is the branch's. Two or more: none is guessed.
      address: addresses.length === 1 ? addresses[0] as string : null,
      bookingUrl: typeof url === 'string' && url.trim() !== '' ? url.trim() : null,
    },
  };
}

export type Session = {
  id: string; tenantId: string; conversationId: string; channelId: string; psid: string; isTest: boolean;
  step: string; data: Record<string, unknown>; version: number; updatedAt: Date; closedAt: Date | null;
};

function toSession(v: unknown): Session {
  const r = rec(v);
  return {
    id: String(r['id']), tenantId: String(r['tenant_id']), conversationId: String(r['conversation_id']),
    channelId: String(r['channel_id']), psid: String(r['psid']), isTest: r['is_test'] === true,
    step: String(r['step']), data: rec(r['data']), version: Number(r['version']),
    updatedAt: new Date(String(r['updated_at'])), closedAt: r['closed_at'] === null || r['closed_at'] === undefined ? null : new Date(String(r['closed_at'])),
  };
}

export async function readOpenSession(db: SupabaseClient, tenantId: string, conversationId: string): Promise<Ok<{ session: Session | null }> | Fail> {
  const { data, error } = await db.from('booking_sessions').select('*')
    .eq('tenant_id', tenantId).eq('conversation_id', conversationId).is('closed_at', null).maybeSingle();
  if (error) return { ok: false, detail: `booking_sessions unreadable: ${error.message}` };
  return { ok: true, session: data === null ? null : toSession(data) };
}

export async function openSession(db: SupabaseClient, input: {
  tenantId: string; conversationId: string; channelId: string; psid: string; isTest: boolean; step: string; data: Record<string, unknown>;
}): Promise<Ok<{ session: Session; created: boolean }> | Fail> {
  const { data, error } = await db.rpc('booking_open_session', {
    p_tenant: input.tenantId, p_conversation: input.conversationId, p_channel: input.channelId, p_psid: input.psid,
    p_is_test: input.isTest, p_step: input.step, p_data: input.data,
  });
  if (error) return { ok: false, detail: `booking_open_session: ${error.message}` };
  const r = rec(data);
  return { ok: true, created: r['created'] === true, session: toSession(r['session']) };
}

export type TurnOutcome = { outcome: 'drafted'; outboundId: string | null } | { outcome: 'exists'; outboundId: string } | { outcome: 'stale' };

export async function applyTurn(db: SupabaseClient, input: {
  tenantId: string; session: Session; dedupKey: string; step: string; data: Record<string, unknown>;
  closeReason: string | null; body: string | null;
}): Promise<Ok<{ turn: TurnOutcome }> | Fail> {
  const { data, error } = await db.rpc('booking_apply_turn', {
    p_tenant: input.tenantId, p_session: input.session.id, p_version: input.session.version, p_dedup_key: input.dedupKey,
    p_step: input.step, p_data: input.data, p_close_reason: input.closeReason, p_body: input.body,
    p_channel: input.session.channelId, p_conversation: input.session.conversationId,
  });
  if (error) return { ok: false, detail: `booking_apply_turn: ${error.message}` };
  const r = rec(data);
  if (r['outcome'] === 'drafted') return { ok: true, turn: { outcome: 'drafted', outboundId: typeof r['outbound_id'] === 'string' ? r['outbound_id'] : null } };
  if (r['outcome'] === 'exists') return { ok: true, turn: { outcome: 'exists', outboundId: String(r['outbound_id']) } };
  if (r['outcome'] === 'stale') return { ok: true, turn: { outcome: 'stale' } };
  return { ok: false, detail: `booking_apply_turn: unexpected answer ${String(r['outcome'])}` };
}

export type HoldState = 'held' | 'paid' | 'booked' | 'expired' | 'released' | 'paid_unbooked';
export type Hold = {
  id: string; tenantId: string; sessionId: string; conversationId: string | null; channelId: string; psid: string; isTest: boolean;
  calendarId: string; staffName: string; level: string; service: string; minutes: number; startsAt: Date; endsAt: Date;
  depositMnt: number; customerName: string; customerPhone: string; gender: 'female' | 'male'; agreedAt: Date; agreementText: string;
  state: HoldState; expiresAt: Date; calendarEventId: string | null; calendarState: 'none' | 'held' | 'booked' | 'deleted';
  paidAt: Date | null; late: boolean;
};

export function toHold(v: unknown): Hold {
  const r = rec(v);
  const d = (k: string) => new Date(String(r[k]));
  return {
    id: String(r['id']), tenantId: String(r['tenant_id']), sessionId: String(r['session_id']),
    conversationId: typeof r['conversation_id'] === 'string' ? r['conversation_id'] : null,
    channelId: String(r['channel_id']), psid: String(r['psid']), isTest: r['is_test'] === true,
    calendarId: String(r['calendar_id']), staffName: String(r['staff_name']), level: String(r['level']),
    service: String(r['service']), minutes: Number(r['minutes']), startsAt: d('starts_at'), endsAt: d('ends_at'),
    depositMnt: Number(r['deposit_mnt']), customerName: String(r['customer_name']), customerPhone: String(r['customer_phone']),
    gender: r['gender'] === 'male' ? 'male' : 'female', agreedAt: d('agreed_at'), agreementText: String(r['agreement_text']),
    state: String(r['state']) as HoldState, expiresAt: d('expires_at'),
    calendarEventId: typeof r['calendar_event_id'] === 'string' ? r['calendar_event_id'] : null,
    calendarState: String(r['calendar_state'] ?? 'none') as Hold['calendarState'],
    paidAt: typeof r['paid_at'] === 'string' ? new Date(r['paid_at']) : null, late: r['late'] === true,
  };
}

export async function readHold(db: SupabaseClient, holdId: string): Promise<Ok<{ hold: Hold | null }> | Fail> {
  const { data, error } = await db.from('booking_holds').select('*').eq('id', holdId).maybeSingle();
  if (error) return { ok: false, detail: `booking_holds unreadable: ${error.message}` };
  return { ok: true, hold: data === null ? null : toHold(data) };
}

export async function sessionHold(db: SupabaseClient, sessionId: string): Promise<Ok<{ hold: Hold | null }> | Fail> {
  const { data, error } = await db.from('booking_holds').select('*').eq('session_id', sessionId)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) return { ok: false, detail: `booking_holds unreadable: ${error.message}` };
  return { ok: true, hold: data === null ? null : toHold(data) };
}

/** Active holds on these calendars that touch [from, to): busy time the calendar may not show yet. */
export async function activeHolds(db: SupabaseClient, calendarIds: readonly string[], from: Date, to: Date): Promise<Ok<{ busy: Map<string, Interval[]> }> | Fail> {
  const { data, error } = await db.from('booking_holds').select('calendar_id, starts_at, ends_at')
    .in('calendar_id', calendarIds as string[]).in('state', ['held', 'paid', 'booked'])
    .lt('starts_at', to.toISOString()).gt('ends_at', from.toISOString());
  if (error) return { ok: false, detail: `booking_holds unreadable: ${error.message}` };
  const busy = new Map<string, Interval[]>();
  for (const row of Array.isArray(data) ? data : []) {
    const r = rec(row);
    const id = String(r['calendar_id']);
    busy.set(id, [...(busy.get(id) ?? []), { start: new Date(String(r['starts_at'])), end: new Date(String(r['ends_at'])) }]);
  }
  return { ok: true, busy };
}

export type HoldInput = {
  calendarId: string; staffName: string; level: string; service: string; minutes: number; startsAt: Date; endsAt: Date;
  depositMnt: number; customerName: string; customerPhone: string; gender: 'female' | 'male'; agreedAt: Date; agreementText: string;
};

export type AcquireOutcome =
  | { outcome: 'held'; hold: Hold }
  | { outcome: 'taken' }
  | { outcome: 'session_has_hold'; holdId: string }
  | { outcome: 'no_session' };

export async function acquireHold(db: SupabaseClient, input: { tenantId: string; sessionId: string; hold: HoldInput; expiresAt: Date }): Promise<Ok<{ acquired: AcquireOutcome }> | Fail> {
  const h = input.hold;
  const { data, error } = await db.rpc('booking_acquire_hold', {
    p_tenant: input.tenantId, p_session: input.sessionId, p_expires_at: input.expiresAt.toISOString(),
    p_hold: {
      calendar_id: h.calendarId, staff_name: h.staffName, level: h.level, service: h.service, minutes: h.minutes,
      starts_at: h.startsAt.toISOString(), ends_at: h.endsAt.toISOString(), deposit_mnt: h.depositMnt,
      customer_name: h.customerName, customer_phone: h.customerPhone, gender: h.gender,
      agreed_at: h.agreedAt.toISOString(), agreement_text: h.agreementText,
    },
  });
  if (error) {
    // The unique index is the second wall: a race the lock did not see is still "taken".
    if ((error as { code?: string }).code === '23505') return { ok: true, acquired: { outcome: 'taken' } };
    return { ok: false, detail: `booking_acquire_hold: ${error.message}` };
  }
  const r = rec(data);
  switch (r['outcome']) {
    case 'held': return { ok: true, acquired: { outcome: 'held', hold: toHold(r['hold']) } };
    case 'taken': return { ok: true, acquired: { outcome: 'taken' } };
    case 'session_has_hold': return { ok: true, acquired: { outcome: 'session_has_hold', holdId: String(r['hold_id']) } };
    case 'no_session': return { ok: true, acquired: { outcome: 'no_session' } };
    default: return { ok: false, detail: `booking_acquire_hold: unexpected answer ${String(r['outcome'])}` };
  }
}

export async function endHold(db: SupabaseClient, holdId: string, kind: 'expired' | 'released', reason: string): Promise<Ok<{ outcome: string }> | Fail> {
  const { data, error } = await db.rpc('booking_end_hold', { p_hold: holdId, p_reason: reason, p_kind: kind });
  if (error) return { ok: false, detail: `booking_end_hold: ${error.message}` };
  return { ok: true, outcome: String(rec(data)['outcome']) };
}

export type Disposition = 'applied' | 'excess' | 'short' | 'late_booked' | 'late_unbooked';
export async function recordPayment(db: SupabaseClient, input: {
  holdId: string; invoiceId: string; paymentKey: string; amountMnt: number; paidAt: Date; qpayInvoiceId: string;
}): Promise<Ok<{ duplicate: boolean; disposition: Disposition; state: HoldState }> | Fail> {
  const { data, error } = await db.rpc('booking_record_payment', {
    p_hold: input.holdId, p_invoice: input.invoiceId, p_payment_key: input.paymentKey, p_amount: input.amountMnt,
    p_paid_at: input.paidAt.toISOString(), p_qpay_invoice_id: input.qpayInvoiceId,
  });
  if (error) return { ok: false, detail: `booking_record_payment: ${error.message}` };
  const r = rec(data);
  return { ok: true, duplicate: r['outcome'] === 'duplicate', disposition: String(r['disposition']) as Disposition, state: String(r['state']) as HoldState };
}

export async function markBooked(db: SupabaseClient, holdId: string, eventId: string): Promise<Ok<{ outcome: string }> | Fail> {
  const { data, error } = await db.rpc('booking_mark_booked', { p_hold: holdId, p_event_id: eventId });
  if (error) return { ok: false, detail: `booking_mark_booked: ${error.message}` };
  return { ok: true, outcome: String(rec(data)['outcome']) };
}

export async function markUnbooked(db: SupabaseClient, holdId: string, reason: string): Promise<Ok<{ outcome: string }> | Fail> {
  const { data, error } = await db.rpc('booking_mark_unbooked', { p_hold: holdId, p_reason: reason });
  if (error) return { ok: false, detail: `booking_mark_unbooked: ${error.message}` };
  return { ok: true, outcome: String(rec(data)['outcome']) };
}

/** Our calendar event's state, after a write to Google. Bookkeeping, never a decision. */
export async function setCalendarState(db: SupabaseClient, holdId: string, eventId: string, state: Hold['calendarState']): Promise<Ok<object> | Fail> {
  const { error } = await db.from('booking_holds').update({ calendar_event_id: eventId, calendar_state: state, updated_at: new Date().toISOString() }).eq('id', holdId);
  return error ? { ok: false, detail: `booking_holds update: ${error.message}` } : { ok: true };
}

export type Invoice = {
  id: string; holdId: string; amountMnt: number; state: 'creating' | 'open' | 'unknown' | 'refused' | 'cancelled';
  qpayInvoiceId: string | null; qrImage: string | null; qrText: string | null;
  urls: { name: string; description: string; logo: string; link: string }[]; qrExpiresAt: Date | null; createdAt: Date;
};

function toInvoice(v: unknown): Invoice {
  const r = rec(v);
  return {
    id: String(r['id']), holdId: String(r['hold_id']), amountMnt: Number(r['amount_mnt']), state: String(r['state']) as Invoice['state'],
    qpayInvoiceId: typeof r['qpay_invoice_id'] === 'string' ? r['qpay_invoice_id'] : null,
    qrImage: typeof r['qr_image'] === 'string' ? r['qr_image'] : null, qrText: typeof r['qr_text'] === 'string' ? r['qr_text'] : null,
    urls: Array.isArray(r['urls']) ? (r['urls'] as unknown[]).map((u) => {
      const x = rec(u);
      return { name: String(x['name'] ?? ''), description: String(x['description'] ?? ''), logo: String(x['logo'] ?? ''), link: String(x['link'] ?? '') };
    }) : [],
    qrExpiresAt: typeof r['qr_expires_at'] === 'string' ? new Date(r['qr_expires_at']) : null,
    createdAt: new Date(String(r['created_at'])),
  };
}

export async function holdInvoices(db: SupabaseClient, holdId: string): Promise<Ok<{ invoices: Invoice[] }> | Fail> {
  const { data, error } = await db.from('booking_invoices').select('*').eq('hold_id', holdId).order('created_at', { ascending: true });
  if (error) return { ok: false, detail: `booking_invoices unreadable: ${error.message}` };
  return { ok: true, invoices: (Array.isArray(data) ? data : []).map(toInvoice) };
}

/** Claim a new invoice row before QPay is asked. */
export async function claimInvoice(db: SupabaseClient, input: { tenantId: string; holdId: string; amountMnt: number }): Promise<Ok<{ invoice: Invoice }> | Fail> {
  const { data, error } = await db.from('booking_invoices').insert({ tenant_id: input.tenantId, hold_id: input.holdId, amount_mnt: input.amountMnt })
    .select('*').maybeSingle();
  if (error || data === null) return { ok: false, detail: `booking_invoices insert: ${error?.message ?? 'no row'}` };
  return { ok: true, invoice: toInvoice(data) };
}

export async function finishInvoice(db: SupabaseClient, invoiceId: string, patch: {
  state: Invoice['state']; qpayInvoiceId?: string; qrImage?: string; qrText?: string; urls?: Invoice['urls']; qrExpiresAt?: Date;
}): Promise<Ok<object> | Fail> {
  const { error } = await db.from('booking_invoices').update({
    state: patch.state, updated_at: new Date().toISOString(),
    ...(patch.qpayInvoiceId === undefined ? {} : { qpay_invoice_id: patch.qpayInvoiceId }),
    ...(patch.qrImage === undefined ? {} : { qr_image: patch.qrImage }),
    ...(patch.qrText === undefined ? {} : { qr_text: patch.qrText }),
    ...(patch.urls === undefined ? {} : { urls: patch.urls }),
    ...(patch.qrExpiresAt === undefined ? {} : { qr_expires_at: patch.qrExpiresAt.toISOString() }),
  }).eq('id', invoiceId);
  return error ? { ok: false, detail: `booking_invoices update: ${error.message}` } : { ok: true };
}

/** Holds a sweep must look at: unpaid past their time, or paid and not yet in the calendar. */
export async function holdsToSweep(db: SupabaseClient, now: Date, limit = 50): Promise<Ok<{ holds: Hold[] }> | Fail> {
  const [due, paid] = await Promise.all([
    db.from('booking_holds').select('*').eq('state', 'held').lte('expires_at', now.toISOString()).order('expires_at').limit(limit),
    db.from('booking_holds').select('*').eq('state', 'paid').order('paid_at').limit(limit),
  ]);
  if (due.error) return { ok: false, detail: `booking_holds unreadable: ${due.error.message}` };
  if (paid.error) return { ok: false, detail: `booking_holds unreadable: ${paid.error.message}` };
  return { ok: true, holds: [...(due.data ?? []), ...(paid.data ?? [])].map(toHold) };
}

/** Recently ended holds whose QPay invoices may still be paid late: asked again for an hour. */
export async function recentlyEnded(db: SupabaseClient, now: Date, limit = 50): Promise<Ok<{ holds: Hold[] }> | Fail> {
  const since = new Date(now.getTime() - 60 * 60_000).toISOString();
  const { data, error } = await db.from('booking_holds').select('*').in('state', ['expired', 'released'])
    .gte('ended_at', since).order('ended_at').limit(limit);
  if (error) return { ok: false, detail: `booking_holds unreadable: ${error.message}` };
  return { ok: true, holds: (data ?? []).map(toHold) };
}

export async function logEvent(db: SupabaseClient, input: { tenantId: string; holdId?: string; sessionId?: string; kind: string; detail?: Record<string, unknown> }): Promise<void> {
  // An audit row that cannot be written is logged by the caller's log and never stops a booking.
  await db.from('booking_events').insert({
    tenant_id: input.tenantId, hold_id: input.holdId ?? null, session_id: input.sessionId ?? null, kind: input.kind, detail: input.detail ?? {},
  });
}
