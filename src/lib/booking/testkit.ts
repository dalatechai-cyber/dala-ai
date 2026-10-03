/**
 * Test doubles for in-chat booking, used by the unit tests and `scripts/verify/booking-e2e.ts`.
 * Nothing deployed imports this file.
 *
 * Both fakes are `fetch` implementations, so the REAL clients run against them: the Quick QR
 * client in `billing/qpay.ts` and the Google Calendar client in `calendar.ts`. What is faked is
 * only the far side of the wire, with the shapes the real services answer:
 *
 *  - QPay Quick QR v2 (`quickqr.qpay.mn/v2`): `/auth/token` (Basic auth, `terminal_id`),
 *    `POST /invoice` → `{id, qr_text, qr_image, urls}`, `POST /payment/check` → the invoice
 *    itself with `payments: [{id, amount, currency, payment_status, payment_status_date}]`
 *    (seen live on 2026-09-28, `billing/qpay.ts`), `DELETE /invoice/{id}`.
 *  - Google: the service-account token exchange (the JWT's RS256 signature is VERIFIED), and
 *    Calendar v3 `freeBusy`, `events.list`, `events.insert` (409 on a used id, deleted ones
 *    included), `events.patch` (brings a deleted event back), `events.delete` (410 when gone).
 */
import { createPublicKey, createVerify, generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { BOOKING_BLOCK_KEYS, type BookingWording } from './wording.ts';

// ---------------------------------------------------------------------------
// Wording: the drafts, plus the eight signed billing lines the page reuses.
// ---------------------------------------------------------------------------

/** Every booking block from `prompt/drafts/booking` and `prompt/platform` (repo root = cwd). */
export function draftWording(root = process.cwd()): BookingWording {
  const blocks = new Map<string, string>();
  for (const dir of ['prompt/platform', 'prompt/drafts/booking']) {
    for (const f of readdirSync(path.join(root, dir))) {
      if (!f.endsWith('.mn.txt')) continue;
      const key = f.slice(0, -'.mn.txt'.length);
      if ((BOOKING_BLOCK_KEYS as readonly string[]).includes(key)) blocks.set(key, readFileSync(path.join(root, dir, f), 'utf8').trim().normalize('NFC'));
    }
  }
  return { source: 'draft', blocks };
}

// ---------------------------------------------------------------------------
// A tiny router for fake fetches
// ---------------------------------------------------------------------------

const json = (status: number, body: unknown): Response =>
  new Response(body === null ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function bodyOf(init: RequestInit | undefined): Promise<string> {
  const b = init?.body;
  return typeof b === 'string' ? b : b === undefined || b === null ? '' : String(b);
}

// ---------------------------------------------------------------------------
// QPay Quick QR
// ---------------------------------------------------------------------------

export type FakeQpayInvoice = {
  id: string; merchantId: string; amount: number; description: string; callbackUrl: string; mcc: string;
  bankAccount: string; status: 'OPEN' | 'PAID' | 'CANCELLED';
  payments: { id: string; amount: number; status: string; at: string }[];
};

export class FakeQpay {
  readonly invoices = new Map<string, FakeQpayInvoice>();
  readonly calls: string[] = [];
  /** Answer the next N `/payment/check` calls with HTTP 500 (QPay down). */
  failChecks = 0;
  /** Refuse every `DELETE /invoice` (QPay would not cancel). */
  failCancel = false;
  /** Answer `/payment/check` for these invoice ids with a body the client cannot read. */
  unreadable = new Set<string>();
  private seq = 0;

  readonly username = 'qpay-user';
  readonly password = 'qpay-pass';
  readonly terminal = 'DALATECH_AI';

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    const p = url.pathname.replace(/^\/v2/u, '');
    this.calls.push(`${method} ${p}`);
    const headers = new Headers(init?.headers);
    if (p === '/auth/token') {
      const want = `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`;
      const body = JSON.parse(await bodyOf(init)) as { terminal_id?: string };
      if (headers.get('authorization') !== want || body.terminal_id !== this.terminal) return json(401, { error: 'unauthorized' });
      return json(200, { access_token: 'qpay-token', expires_in: 3600 });
    }
    if (headers.get('authorization') !== 'Bearer qpay-token') return json(401, { error: 'unauthorized' });
    if (p === '/invoice' && method === 'POST') {
      const b = JSON.parse(await bodyOf(init)) as Record<string, unknown>;
      const id = randomUUID();
      const banks = b['bank_accounts'] as { account_number: string }[];
      this.invoices.set(id, {
        id, merchantId: String(b['merchant_id']), amount: Number(b['amount']), description: String(b['description']),
        callbackUrl: String(b['callback_url']), mcc: String(b['mcc_code']), bankAccount: banks[0]?.account_number ?? '',
        status: 'OPEN', payments: [],
      });
      return json(200, {
        id, qr_text: `qr-${id}`, qr_image: Buffer.from(`png-${id}`).toString('base64'),
        urls: [
          { name: 'Khan bank', description: 'Хаан банк', logo: 'https://qpay.mn/q/logo/khanbank.png', link: `khanbank://q?qPay_QRcode=qr-${id}` },
          { name: 'Golomt bank', description: 'Голомт банк', logo: 'https://qpay.mn/q/logo/golomtbank.png', link: `golomtbank://q?qPay_QRcode=qr-${id}` },
        ],
      });
    }
    if (p === '/payment/check' && method === 'POST') {
      const b = JSON.parse(await bodyOf(init)) as { invoice_id: string };
      if (this.failChecks > 0) { this.failChecks -= 1; return json(500, { error: 'down' }); }
      const inv = this.invoices.get(b.invoice_id);
      if (inv === undefined) return json(404, { error: 'INVOICE_NOTFOUND' });
      if (this.unreadable.has(inv.id)) {
        return json(200, { id: inv.id, invoice_status: 'PAID', payments: [{ id: 'x', amount: inv.amount, currency: 'MNT', payment_status: 'WEIRD' }] });
      }
      return json(200, {
        id: inv.id, invoice_status: inv.status, invoice_status_date: null,
        payments: inv.payments.map((x) => ({ id: x.id, amount: String(x.amount), currency: 'MNT', payment_status: x.status, payment_status_date: x.at })),
      });
    }
    const del = /^\/invoice\/([^/]+)$/u.exec(p);
    if (del !== null && method === 'DELETE') {
      const inv = this.invoices.get(decodeURIComponent(del[1] as string));
      if (inv === undefined) return json(404, { error: 'INVOICE_NOTFOUND' });
      if (this.failCancel) return json(500, { error: 'down' });
      if (inv.status === 'PAID') return json(422, { error: 'INVOICE_PAID' });
      inv.status = 'CANCELLED';
      return json(200, { success: true });
    }
    return json(404, { error: 'NOT_FOUND' });
  };

  /** The customer pays in the bank app. Allowed on an open invoice, or `force` (a payment QPay took before a cancel landed). */
  pay(invoiceId: string, opts: { amount?: number; force?: boolean; at?: Date } = {}): string {
    const inv = this.invoices.get(invoiceId);
    if (inv === undefined) throw new Error(`no invoice ${invoiceId}`);
    if (inv.status !== 'OPEN' && opts.force !== true) throw new Error(`invoice ${invoiceId} is ${inv.status}`);
    this.seq += 1;
    const id = `pay-${this.seq}-${invoiceId.slice(0, 8)}`;
    inv.payments.push({ id, amount: opts.amount ?? inv.amount, status: 'PAID', at: (opts.at ?? new Date()).toISOString() });
    inv.status = 'PAID';
    return id;
  }

  /** The bank pays the same invoice a second time (it happens: two taps). */
  payAgain(invoiceId: string): string {
    const inv = this.invoices.get(invoiceId);
    if (inv === undefined) throw new Error(`no invoice ${invoiceId}`);
    return this.pay(invoiceId, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Google Calendar
// ---------------------------------------------------------------------------

export type FakeEvent = {
  id: string; status: 'confirmed' | 'cancelled'; transparency: 'opaque' | 'transparent';
  start: Date; end: Date; summary: string; description: string; privateProps: Record<string, string>;
};

export class FakeGoogle {
  readonly calendars = new Map<string, Map<string, FakeEvent>>();
  readonly calls: string[] = [];
  readonly privateKey: string;
  readonly email = 'booking@tara-site.iam.gserviceaccount.com';
  private readonly publicKey: KeyObject;
  /** Called after each successful insert: lets a test write a "website" booking in the gap. */
  afterInsert: ((calendarId: string, ev: FakeEvent) => void) | null = null;
  /** Calendars whose free/busy answer carries an error (not shared with the service account). */
  readonly brokenCalendars = new Set<string>();
  failAll = false;

  constructor(calendarIds: readonly string[]) {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.privateKey = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().replace(/\n/gu, '\\n');
    this.publicKey = createPublicKey(publicKey.export({ type: 'spki', format: 'pem' }));
    for (const id of calendarIds) this.calendars.set(id, new Map());
  }

  /** The website (or a person) books a time directly in the calendar. */
  websiteBooks(calendarId: string, start: Date, minutes: number, id = `qb${randomUUID().replace(/-/gu, '')}`): FakeEvent {
    const ev: FakeEvent = { id, status: 'confirmed', transparency: 'opaque', start, end: new Date(start.getTime() + minutes * 60_000), summary: 'website', description: '', privateProps: {} };
    this.cal(calendarId).set(id, ev);
    return ev;
  }

  live(calendarId: string): FakeEvent[] {
    return [...this.cal(calendarId).values()].filter((e) => e.status === 'confirmed');
  }

  private cal(id: string): Map<string, FakeEvent> {
    const c = this.calendars.get(id);
    if (c === undefined) throw new Error(`no calendar ${id}`);
    return c;
  }

  private verifyJwt(assertion: string): boolean {
    const [h, p, s] = assertion.split('.');
    if (h === undefined || p === undefined || s === undefined) return false;
    const ok = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(this.publicKey, Buffer.from(s, 'base64url'));
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<string, unknown>;
    return ok && claims['iss'] === this.email && claims['aud'] === 'https://oauth2.googleapis.com/token'
      && claims['scope'] === 'https://www.googleapis.com/auth/calendar';
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    this.calls.push(`${method} ${url.pathname}`);
    if (this.failAll) return json(503, { error: 'backend' });
    if (url.href === 'https://oauth2.googleapis.com/token') {
      const form = new URLSearchParams(await bodyOf(init));
      if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer' || !this.verifyJwt(form.get('assertion') ?? '')) {
        return json(400, { error: 'invalid_grant' });
      }
      return json(200, { access_token: 'g-token', expires_in: 3600, token_type: 'Bearer' });
    }
    if (new Headers(init?.headers).get('authorization') !== 'Bearer g-token') return json(401, { error: 'unauthenticated' });
    const base = '/calendar/v3';
    if (url.pathname === `${base}/freeBusy` && method === 'POST') {
      const b = JSON.parse(await bodyOf(init)) as { timeMin: string; timeMax: string; items: { id: string }[] };
      const from = new Date(b.timeMin).getTime();
      const to = new Date(b.timeMax).getTime();
      const calendars: Record<string, unknown> = {};
      for (const { id } of b.items) {
        if (this.brokenCalendars.has(id) || !this.calendars.has(id)) {
          calendars[id] = { errors: [{ domain: 'global', reason: 'notFound' }], busy: [] };
          continue;
        }
        calendars[id] = {
          busy: this.live(id).filter((e) => e.transparency === 'opaque' && e.start.getTime() < to && from < e.end.getTime())
            .map((e) => ({ start: e.start.toISOString(), end: e.end.toISOString() })),
        };
      }
      return json(200, { kind: 'calendar#freeBusy', timeMin: b.timeMin, timeMax: b.timeMax, calendars });
    }
    const m = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/u.exec(url.pathname);
    if (m === null) return json(404, { error: 'notFound' });
    const calId = decodeURIComponent(m[1] as string);
    if (!this.calendars.has(calId) || this.brokenCalendars.has(calId)) return json(404, { error: 'notFound' });
    const cal = this.cal(calId);
    const eventId = m[2] === undefined ? null : decodeURIComponent(m[2]);
    const read = (b: Record<string, unknown>): Partial<FakeEvent> => {
      const out: Partial<FakeEvent> = {};
      const time = (v: unknown) => new Date(String((v as Record<string, unknown>)['dateTime']));
      if (b['start'] !== undefined) out.start = time(b['start']);
      if (b['end'] !== undefined) out.end = time(b['end']);
      if (typeof b['summary'] === 'string') out.summary = b['summary'];
      if (typeof b['description'] === 'string') out.description = b['description'];
      if (b['transparency'] === 'transparent' || b['transparency'] === 'opaque') out.transparency = b['transparency'];
      if (b['status'] === 'confirmed' || b['status'] === 'cancelled') out.status = b['status'];
      const ext = b['extendedProperties'] as { private?: Record<string, string> } | undefined;
      if (ext?.private !== undefined) out.privateProps = ext.private;
      return out;
    };
    const wire = (e: FakeEvent) => ({
      id: e.id, status: e.status, summary: e.summary, ...(e.transparency === 'transparent' ? { transparency: 'transparent' } : {}),
      start: { dateTime: e.start.toISOString() }, end: { dateTime: e.end.toISOString() },
    });
    if (eventId === null && method === 'GET') {
      const from = new Date(url.searchParams.get('timeMin') ?? '').getTime();
      const to = new Date(url.searchParams.get('timeMax') ?? '').getTime();
      return json(200, { items: this.live(calId).filter((e) => e.start.getTime() < to && from < e.end.getTime()).map(wire) });
    }
    if (eventId === null && method === 'POST') {
      const b = JSON.parse(await bodyOf(init)) as Record<string, unknown>;
      const id = String(b['id'] ?? randomUUID().replace(/-/gu, ''));
      if (cal.has(id)) return json(409, { error: { code: 409, message: 'The requested identifier already exists.' } });
      const ev: FakeEvent = { id, status: 'confirmed', transparency: 'opaque', summary: '', description: '', privateProps: {}, start: new Date(0), end: new Date(0), ...read(b) } as FakeEvent;
      cal.set(id, ev);
      this.afterInsert?.(calId, ev);
      return json(200, wire(ev));
    }
    if (eventId !== null && method === 'GET') {
      // One event, as Google answers it (a cancelled one too, with its status); the website reads these.
      const ev = cal.get(eventId);
      if (ev === undefined) return json(404, { error: 'notFound' });
      return json(200, { ...wire(ev), description: ev.description, extendedProperties: { private: ev.privateProps } });
    }
    if (eventId !== null && method === 'PATCH') {
      const ev = cal.get(eventId);
      if (ev === undefined) return json(404, { error: 'notFound' });
      Object.assign(ev, read(JSON.parse(await bodyOf(init)) as Record<string, unknown>));
      return json(200, wire(ev));
    }
    if (eventId !== null && method === 'DELETE') {
      const ev = cal.get(eventId);
      if (ev === undefined) return json(404, { error: 'notFound' });
      if (ev.status === 'cancelled') return json(410, { error: 'deleted' });
      ev.status = 'cancelled';
      return new Response(null, { status: 204 });
    }
    return json(405, { error: 'method' });
  };
}

// ---------------------------------------------------------------------------
// A tenant's booking config, as the founder would write it (shape only; test values).
// ---------------------------------------------------------------------------

export const TEST_CALENDARS = {
  master1: 'master1@group.calendar.google.com',
  master2: 'master2@group.calendar.google.com',
  first1: 'first1@group.calendar.google.com',
  male1: 'male1@group.calendar.google.com',
} as const;

export function testConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    test_sender_ids: ['psid-tester'],
    hold_minutes: 5,
    slot_step_minutes: 60,
    days_ahead: 7,
    gender_rule: true,
    agreement_text: 'Урьдчилгаа төлбөр нь цагаа цуцалсан эсвэл ирээгүй тохиолдолд буцаан олгогдохгүй гэдгийг ойлгож, зөвшөөрч байна.',
    entry_matchers: [
      { mode: 'stem_sequence', stems: ['цаг', 'ав'], windowCp: 20 },
      { mode: 'stem_sequence', stems: ['tsag', 'av'], windowCp: 20 },
    ],
    levels: [
      { key: 'master', label: 'Мастер', deposit_mnt: 20000 },
      { key: 'first', label: '1-р зэрэг', deposit_mnt: 10000 },
    ],
    stylists: [
      { name: 'Оюунсүрэн', label: 'Оюунаа', level: 'master', gender: 'female', calendar_id: TEST_CALENDARS.master1 },
      { name: 'Бадамцэцэг', label: 'Бадмаа', level: 'master', gender: 'female', calendar_id: TEST_CALENDARS.master2 },
      { name: 'Уянга', label: 'Уянга', level: 'first', gender: 'female', calendar_id: TEST_CALENDARS.first1 },
      { name: 'Ананд', label: 'Ананд', level: 'master', gender: 'male', calendar_id: TEST_CALENDARS.male1 },
    ],
    service_groups: [
      { label: 'Засалт', services: [{ name: 'Энгийн засалт', minutes: 60 }, { name: 'Гоёлын засалт, хуримын засалт', label: 'Гоёл / Засалт', minutes: 90 }] },
      { label: 'Будаг', services: [{ name: 'Будаг', minutes: 120 }, { name: 'Оффис колор', minutes: 240 }] },
    ],
    qpay: {
      merchant_id: '00000000-0000-4000-8000-00000000c0de',
      mcc_code: '7230',
      bank_accounts: [{ bank_code: '040000', account_number: 'TEST-ACCOUNT', account_name: 'Test holder' }],
    },
    ...overrides,
  };
}
