/**
 * Test doubles for in-chat booking, used by the unit tests and `scripts/verify/booking-e2e.ts`.
 * Nothing deployed imports this file.
 *
 * Both fakes are `fetch` implementations, so the REAL clients run against them: the Quick QR
 * client in `billing/qpay.ts` and the Google Calendar client in `calendar.ts`. What is faked is
 * only the far side of the wire, with the shapes the real services answer:
 *
 *  - QPay Quick QR v2 (`quickqr.qpay.mn/v2`): `/auth/token` (Basic auth, `terminal_id`; one
 *    token per partner login), `POST /invoice` → `{id, qr_text, qr_image, urls}`, refused
 *    unless its `merchant_id` is registered under the token's login (QPay's merchants are
 *    registered per partner login, `POST /v2/merchant/company|person`) and it carries one
 *    complete `bank_accounts` entry, `POST /payment/check` → the invoice itself with
 *    `payments: [{id, amount, currency, payment_status, payment_status_date}]` (seen live on
 *    2026-09-28, `billing/qpay.ts`), `DELETE /invoice/{id}`. Every invoice keeps the merchant
 *    and the payout account it was made with, so a test can say whose money it is.
 *  - Google: the service-account token exchange (the JWT's RS256 signature is VERIFIED), and
 *    Calendar v3 `freeBusy`, `events.list` (with `created` and `extendedProperties`, and the
 *    `privateExtendedProperty` filter), `events.insert` (409 on a used id, deleted ones
 *    included), `events.get`, `events.patch` (brings a deleted event back), `events.delete` (410
 *    when gone). `websiteHolds` writes a hold exactly as the website's `services/bookingHold.js`.
 */
import { createHash, createPublicKey, createVerify, generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { BOOKING_BLOCK_KEYS, type BookingWording } from './wording.ts';
import { branchConfig, type RawQpay } from './rules.ts';

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
  bankAccount: string; bankCode: string; accountName: string; login: string; status: 'OPEN' | 'PAID' | 'CANCELLED';
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

  /** The platform's partner login (the website's and the platform's `QPAY_*`). */
  readonly username = 'qpay-user';
  readonly password = 'qpay-pass';
  readonly terminal = 'DALATECH_AI';
  /** Partner logins: username → password, terminal, and the merchants registered under it. */
  readonly logins = new Map<string, { password: string; terminal: string; merchants: Set<string> }>();

  constructor() {
    this.addLogin(this.username, this.password, this.terminal);
  }

  /** Another partner login (a branch with its own). */
  addLogin(username: string, password: string, terminal: string): void {
    this.logins.set(username, { password, terminal, merchants: new Set() });
  }

  /** `POST /v2/merchant/company`: a merchant registered under a login. Invoices name it. */
  registerMerchant(username: string, merchantId: string): void {
    const l = this.logins.get(username);
    if (l === undefined) throw new Error(`no QPay login ${username}`);
    l.merchants.add(merchantId);
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    const p = url.pathname.replace(/^\/v2/u, '');
    this.calls.push(`${method} ${p}`);
    const headers = new Headers(init?.headers);
    if (p === '/auth/token') {
      const body = JSON.parse(await bodyOf(init)) as { terminal_id?: string };
      const basic = /^Basic (.+)$/u.exec(headers.get('authorization') ?? '');
      const [user, ...rest] = Buffer.from(basic?.[1] ?? '', 'base64').toString().split(':');
      const l = this.logins.get(user ?? '');
      if (l === undefined || l.password !== rest.join(':') || body.terminal_id !== l.terminal) return json(401, { error: 'unauthorized' });
      return json(200, { access_token: `qpay-token-${user as string}`, expires_in: 3600 });
    }
    const login = /^Bearer qpay-token-(.+)$/u.exec(headers.get('authorization') ?? '')?.[1];
    if (login === undefined || !this.logins.has(login)) return json(401, { error: 'unauthorized' });
    if (p === '/invoice' && method === 'POST') {
      const b = JSON.parse(await bodyOf(init)) as Record<string, unknown>;
      const merchantId = String(b['merchant_id'] ?? '');
      if (!(this.logins.get(login) as { merchants: Set<string> }).merchants.has(merchantId)) return json(400, { error: 'MERCHANT_NOTFOUND' });
      const banks = Array.isArray(b['bank_accounts']) ? b['bank_accounts'] as Record<string, unknown>[] : [];
      const bank = banks[0];
      if (banks.length !== 1 || bank === undefined || [bank['account_bank_code'], bank['account_number'], bank['account_name']].some((v) => typeof v !== 'string' || v === '')) {
        return json(400, { error: 'INVALID_BANK_ACCOUNTS' });
      }
      const id = randomUUID();
      this.invoices.set(id, {
        id, merchantId, amount: Number(b['amount']), description: String(b['description']),
        callbackUrl: String(b['callback_url']), mcc: String(b['mcc_code']), bankAccount: String(bank['account_number']),
        bankCode: String(bank['account_bank_code']), accountName: String(bank['account_name']), login,
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
      // Another login's invoice is not this login's to read: as unknown as one that never existed.
      if (inv === undefined || inv.login !== login) return json(404, { error: 'INVOICE_NOTFOUND' });
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
      if (inv === undefined || inv.login !== login) return json(404, { error: 'INVOICE_NOTFOUND' });
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
  /** Google's `created`: set once on insert, strictly increasing here (two writes never tie). */
  created: Date;
};

/** The website's hold id (matrix_website `services/bookingHold.js` `holdIdFor`): `sh` + 40 hex, base32hex. */
export function websiteHoldId(calendarId: string, start: Date, phone: string): string {
  return `sh${createHash('sha256').update(`${calendarId}|${start.toISOString()}|${phone.replace(/\D/gu, '')}`).digest('hex').slice(0, 40)}`;
}

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
  /** Writes (insert, patch, delete) answer 503; reads still work. */
  failWrites = false;
  /** Another id for a calendar (the website's real id → the test calendar both sides write to). */
  readonly aliases = new Map<string, string>();
  private lastCreated = 0;
  /** The clock `created` is stamped with (the e2e shifts it). */
  now: () => Date = () => new Date();

  private stamp(): Date {
    this.lastCreated = Math.max(this.now().getTime(), this.lastCreated + 1);
    return new Date(this.lastCreated);
  }

  constructor(calendarIds: readonly string[]) {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.privateKey = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().replace(/\n/gu, '\\n');
    this.publicKey = createPublicKey(publicKey.export({ type: 'spki', format: 'pem' }));
    for (const id of calendarIds) this.calendars.set(id, new Map());
  }

  /** The website (or a person) books a time directly in the calendar. */
  websiteBooks(calendarId: string, start: Date, minutes: number, id = `qb${randomUUID().replace(/-/gu, '')}`): FakeEvent {
    const ev: FakeEvent = { id, status: 'confirmed', transparency: 'opaque', start, end: new Date(start.getTime() + minutes * 60_000), summary: 'website', description: '', privateProps: {}, created: this.stamp() };
    this.cal(calendarId).set(id, ev);
    return ev;
  }

  /**
   * The website holds a time while its customer looks at the QR, exactly as its contract says:
   * an opaque `sh…` event over the whole appointment, `{ taraHold: '1', holdExpiresAt,
   * holdPlacedAt, holdPhone }`. `placedAt` defaults to the event's own `created`.
   */
  websiteHolds(calendarId: string, start: Date, minutes: number, phone: string, expiresAt: Date, placedAt?: Date): FakeEvent {
    const id = websiteHoldId(calendarId, start, phone);
    const created = this.stamp();
    const digits = phone.replace(/\D/gu, '');
    const ev: FakeEvent = {
      id, status: 'confirmed', transparency: 'opaque', start, end: new Date(start.getTime() + minutes * 60_000),
      summary: `⏳ Түр хадгалсан (төлбөр хүлээж байна) – ${digits}`, description: 'Website hold',
      privateProps: { taraHold: '1', holdExpiresAt: expiresAt.toISOString(), holdPlacedAt: (placedAt ?? created).toISOString(), holdPhone: digits }, created,
    };
    this.cal(calendarId).set(id, ev);
    return ev;
  }

  live(calendarId: string): FakeEvent[] {
    return [...this.cal(calendarId).values()].filter((e) => e.status === 'confirmed');
  }

  private cal(raw: string): Map<string, FakeEvent> {
    const id = this.aliases.get(raw) ?? raw;
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
    if (this.failWrites && method !== 'GET' && !url.pathname.endsWith('/freeBusy') && url.hostname !== 'oauth2.googleapis.com') return json(503, { error: 'backend' });
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
      for (const { id: asked } of b.items) {
        const id = this.aliases.get(asked) ?? asked;
        if (this.brokenCalendars.has(id) || !this.calendars.has(id)) {
          calendars[asked] = { errors: [{ domain: 'global', reason: 'notFound' }], busy: [] };
          continue;
        }
        calendars[asked] = {
          busy: this.live(id).filter((e) => e.transparency === 'opaque' && e.start.getTime() < to && from < e.end.getTime())
            .map((e) => ({ start: e.start.toISOString(), end: e.end.toISOString() })),
        };
      }
      return json(200, { kind: 'calendar#freeBusy', timeMin: b.timeMin, timeMax: b.timeMax, calendars });
    }
    const m = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/u.exec(url.pathname);
    if (m === null) return json(404, { error: 'notFound' });
    const rawId = decodeURIComponent(m[1] as string);
    const calId = this.aliases.get(rawId) ?? rawId;
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
      created: e.created.toISOString(), updated: e.created.toISOString(),
      start: { dateTime: e.start.toISOString() }, end: { dateTime: e.end.toISOString() },
      ...(Object.keys(e.privateProps).length === 0 ? {} : { extendedProperties: { private: e.privateProps } }),
    });
    if (eventId === null && method === 'GET') {
      const from = new Date(url.searchParams.get('timeMin') ?? '').getTime();
      const to = new Date(url.searchParams.get('timeMax') ?? '').getTime();
      // `privateExtendedProperty=k=v` keeps only events carrying that private property.
      const [pk, pv] = (url.searchParams.get('privateExtendedProperty') ?? '').split('=');
      return json(200, {
        items: this.live(calId).filter((e) => e.start.getTime() < to && from < e.end.getTime())
          .filter((e) => pk === undefined || pk === '' || e.privateProps[pk] === pv).map(wire),
      });
    }
    if (eventId === null && method === 'POST') {
      const b = JSON.parse(await bodyOf(init)) as Record<string, unknown>;
      const id = String(b['id'] ?? randomUUID().replace(/-/gu, ''));
      if (cal.has(id)) return json(409, { error: { code: 409, message: 'The requested identifier already exists.' } });
      const ev: FakeEvent = { id, status: 'confirmed', transparency: 'opaque', summary: '', description: '', privateProps: {}, start: new Date(0), end: new Date(0), ...read(b), created: this.stamp() } as FakeEvent;
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

/** One test calendar per stylist of the two Tara branches, by the website's Latin key, lower case. */
export const TEST_CALENDARS = {
  oyunaa: 'oyunaa@group.calendar.google.com',
  badamaa: 'badamaa@group.calendar.google.com',
  uyanga: 'uyanga@group.calendar.google.com',
  zaya: 'zaya@group.calendar.google.com',
  chimgee: 'chimgee@group.calendar.google.com',
  otgonjargal: 'otgonjargal@group.calendar.google.com',
  anand: 'anand@group.calendar.google.com',
  boloroo: 'boloroo@group.calendar.google.com',
  saraa: 'saraa@group.calendar.google.com',
  tomoo: 'tomoo@group.calendar.google.com',
  bulgaa: 'bulgaa@group.calendar.google.com',
  enhuush: 'enhuush@group.calendar.google.com',
  chimegee: 'chimegee@group.calendar.google.com',
  tuchku: 'tuchku@group.calendar.google.com',
} as const;

/** Each branch's own test merchant and payout account, by its place in the rules file (test values; never a real one). */
const TEST_MERCHANT_VALUES: readonly RawQpay[] = [
  { merchant_id: '00000000-0000-4000-8000-00000000c0de', mcc_code: '7230', bank_accounts: [{ bank_code: '040000', account_number: '1111000001', account_name: 'First branch test holder' }] },
  { merchant_id: '00000000-0000-4000-8000-0000000000d0', mcc_code: '7230', bank_accounts: [{ bank_code: '050000', account_number: '2222000002', account_name: 'Second branch test holder' }] },
];

/** The brand rules every branch's config is built from (repo root = cwd). */
export function taraRules(root = process.cwd()): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(root, 'config/booking/tara-salon.json'), 'utf8')) as Record<string, unknown>;
}

/**
 * The rules file's branch keys, in its order. Tests name a branch by its place here, never by a
 * tenant slug in a literal (a client is rows, CLAUDE.md).
 */
export function ruleBranches(root = process.cwd()): string[] {
  return Object.keys(taraRules(root)['branches'] as Record<string, unknown>);
}

/** A branch's test merchant: its own, by its place in the rules file. */
export function testMerchant(branch: string): RawQpay {
  const i = ruleBranches().indexOf(branch);
  const m = TEST_MERCHANT_VALUES[i];
  if (m === undefined) throw new Error(`no test merchant for branch ${branch}`);
  return JSON.parse(JSON.stringify(m)) as RawQpay;
}

/**
 * A branch's real booking config (`config/booking/tara-salon.json`: the current price list, the
 * confirmed minutes, the founder's stylists, levels and deposits), with test calendars, the
 * branch's test merchant and one tester, then `overrides`. `calendars: false` leaves every
 * calendar «not connected»; `qpay: 'not-connected'` in `overrides` the merchant.
 */
export function taraConfig(branch: string, overrides: Record<string, unknown> = {}, opts: { calendars?: boolean } = {}): Record<string, unknown> {
  const built = branchConfig(taraRules(), branch, {
    calendarFor: (w) => (opts.calendars === false ? null : (TEST_CALENDARS as Record<string, string>)[w.toLowerCase()] ?? null),
    qpay: testMerchant(branch),
    testSenderIds: ['psid-tester'],
  });
  if (!built.ok) throw new Error(built.detail);
  return { ...built.config, ...overrides };
}

/** The first branch's config (the tests' default tenant). */
export function testConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return taraConfig(ruleBranches()[0] as string, overrides);
}
