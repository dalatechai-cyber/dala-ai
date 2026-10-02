/**
 * The stylists' Google Calendars: the only place availability lives, shared with the tenant's
 * website (which keeps no database of its own and reads the same calendars' free/busy).
 *
 * The website's service account is the credential (`GOOGLE_SERVICE_ACCOUNT_EMAIL`,
 * `GOOGLE_PRIVATE_KEY`, the same names and values as its own environment); each stylist's
 * calendar is shared with it as a writer. A token is fetched per port, i.e. per job, and lives
 * only as long as that job: never a module-scope credential cache (rule 7).
 *
 * ## Three outcomes, like QPay's
 *
 * `ok`, `refused` (an HTTP 4xx that says what happened) and `unknown` (no answer, a timeout, a
 * 5xx). A busy read that is not wholly `ok` is a failure: availability is never guessed from a
 * partial answer, and a calendar Google reports an error for is never read as empty.
 */
import { createSign } from 'node:crypto';
import { localDayStart } from '../time/clock.ts';
import type { Interval } from './slots.ts';

export const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/calendar';
const TIMEOUT_MS = 10_000;

export type CalendarFailure = { ok: false; outcome: 'refused' | 'unknown'; detail: string; status?: number };

/** An event as far as availability cares: what it is, when, and whether it blocks time. */
export type CalendarEvent = { id: string; cancelled: boolean; blocks: boolean; start: Date; end: Date };

export type NewEvent = {
  id: string;
  summary: string;
  description: string;
  start: Date;
  end: Date;
  /** `opaque` blocks free/busy, which is what makes the website stop offering the time. */
  transparency: 'opaque' | 'transparent';
  privateProps: Record<string, string>;
};

export type CalendarPort = {
  /** Busy intervals per calendar over [from, to). Any calendar Google cannot answer: failure. */
  busy(calendarIds: readonly string[], from: Date, to: Date): Promise<{ ok: true; busy: Map<string, Interval[]> } | CalendarFailure>;
  /** Events touching [from, to), including our own. Date-only (all-day) events are read on `timezone`. */
  events(calendarId: string, from: Date, to: Date, timezone: string): Promise<{ ok: true; events: CalendarEvent[] } | CalendarFailure>;
  /** Insert with OUR id. `exists`: an event with this id is already there (Google's 409). */
  insert(calendarId: string, event: NewEvent): Promise<{ ok: true } | { ok: false; outcome: 'exists' } | CalendarFailure>;
  /** Rewrite our event (the hold becomes the booking). `gone`: deleted or never there. */
  patch(calendarId: string, eventId: string, event: Omit<NewEvent, 'id'>): Promise<{ ok: true } | { ok: false; outcome: 'gone' } | CalendarFailure>;
  /** Remove our event. Already gone counts as done. */
  remove(calendarId: string, eventId: string): Promise<{ ok: true } | CalendarFailure>;
};

/**
 * A Google event id for our event: base32hex characters (`0-9a-v`), 5–1024 long. The hold's
 * own uuid is hex, which is inside base32hex. `dh` marks it as this platform's; the website's
 * own ids begin `qb`/`qp`, so the two can never collide.
 */
export function eventIdForHold(holdId: string): string {
  const hex = holdId.toLowerCase().replace(/-/gu, '');
  if (!/^[0-9a-f]{32}$/u.test(hex)) throw new RangeError('a hold id is a uuid');
  return `dh${hex}`;
}

type Fetch = typeof fetch;

async function call(
  fetchImpl: Fetch, url: string, init: { method: string; headers: Record<string, string>; body?: string },
): Promise<{ ok: true; status: number; json: unknown } | CalendarFailure> {
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    return { ok: false, outcome: 'unknown', detail: `calendar: ${err instanceof Error ? err.name : 'error'}` };
  }
  const text = await res.text().catch(() => '');
  let json: unknown = null;
  try { json = text === '' ? null : JSON.parse(text); } catch { json = null; }
  if (res.status >= 400 && res.status < 500) return { ok: false, outcome: 'refused', detail: `calendar: HTTP ${res.status}`, status: res.status };
  if (!res.ok) return { ok: false, outcome: 'unknown', detail: `calendar: HTTP ${res.status}`, status: res.status };
  return { ok: true, status: res.status, json };
}

const rec = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

/** An event's time: `dateTime` as given, or a `date` (all day) as that day's local midnight. */
function timeOf(v: unknown, timezone: string): Date | null {
  const r = rec(v);
  if (typeof r['dateTime'] === 'string') {
    const d = new Date(r['dateTime']);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof r['date'] === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(r['date'])) return localDayStart(r['date'], timezone);
  return null;
}

/** Read one events.list item. An event whose times cannot be read blocks the whole window. */
export function readEvent(item: unknown, timezone: string, from: Date, to: Date): CalendarEvent | null {
  const r = rec(item);
  const id = typeof r['id'] === 'string' ? r['id'] : null;
  if (id === null) return null;
  const cancelled = r['status'] === 'cancelled';
  const start = timeOf(r['start'], timezone) ?? from;
  const end = timeOf(r['end'], timezone) ?? to;
  // Google omits `transparency` for the default, which is opaque (busy).
  const blocks = !cancelled && r['transparency'] !== 'transparent';
  return { id, cancelled, blocks, start, end };
}

function eventBody(e: Omit<NewEvent, 'id'>): Record<string, unknown> {
  return {
    summary: e.summary,
    description: e.description,
    start: { dateTime: e.start.toISOString() },
    end: { dateTime: e.end.toISOString() },
    transparency: e.transparency,
    extendedProperties: { private: e.privateProps },
  };
}

/** The live port, on the service account. `fetchImpl` is the test seam. */
export function googleCalendar(creds: { email: string; privateKey: string }, fetchImpl: Fetch = fetch, now: () => Date = () => new Date()): CalendarPort {
  let token: { value: string; until: number } | null = null;

  async function bearer(): Promise<{ ok: true; token: string } | CalendarFailure> {
    if (token !== null && token.until > now().getTime() + 60_000) return { ok: true, token: token.value };
    const iat = Math.floor(now().getTime() / 1000);
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: creds.email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 })}`;
    let sig: string;
    try {
      // Vercel stores a multi-line key with literal `\n`; the website normalises it the same way.
      sig = createSign('RSA-SHA256').update(unsigned).sign(creds.privateKey.replace(/\\n/gu, '\n'), 'base64url');
    } catch {
      return { ok: false, outcome: 'refused', detail: 'calendar: the service account key cannot sign' };
    }
    const r = await call(fetchImpl, TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }).toString(),
    });
    if (!r.ok) return r;
    const t = rec(r.json)['access_token'];
    const ttl = rec(r.json)['expires_in'];
    if (typeof t !== 'string' || t === '') return { ok: false, outcome: 'refused', detail: 'calendar: no access_token' };
    token = { value: t, until: now().getTime() + (typeof ttl === 'number' ? ttl : 3600) * 1000 };
    return { ok: true, token: t };
  }

  const authed = async (url: string, method: string, body?: unknown) => {
    const b = await bearer();
    if (!b.ok) return b;
    return call(fetchImpl, url, {
      method,
      headers: { authorization: `Bearer ${b.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  };
  const cal = (id: string) => `${CALENDAR_API}/calendars/${encodeURIComponent(id)}`;

  return {
    async busy(calendarIds, from, to) {
      const r = await authed(`${CALENDAR_API}/freeBusy`, 'POST', {
        timeMin: from.toISOString(), timeMax: to.toISOString(), items: calendarIds.map((id) => ({ id })),
      });
      if (!r.ok) return r;
      const cals = rec(rec(r.json)['calendars']);
      const out = new Map<string, Interval[]>();
      for (const id of calendarIds) {
        const c = rec(cals[id]);
        if (Array.isArray(c['errors']) && c['errors'].length > 0) {
          return { ok: false, outcome: 'refused', detail: `calendar: free/busy error on a calendar (${String(rec(c['errors'][0])['reason'] ?? 'unknown')})` };
        }
        if (!Array.isArray(c['busy'])) return { ok: false, outcome: 'unknown', detail: 'calendar: free/busy answer has no busy list' };
        const list: Interval[] = [];
        for (const b of c['busy']) {
          const s = new Date(String(rec(b)['start'] ?? ''));
          const e = new Date(String(rec(b)['end'] ?? ''));
          if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return { ok: false, outcome: 'unknown', detail: 'calendar: unreadable busy interval' };
          list.push({ start: s, end: e });
        }
        out.set(id, list);
      }
      return { ok: true, busy: out };
    },

    async events(calendarId, from, to, timezone) {
      const events: CalendarEvent[] = [];
      let page: string | null = null;
      for (let i = 0; i < 10; i += 1) {
        const q = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: 'true', showDeleted: 'false', maxResults: '250' });
        if (page !== null) q.set('pageToken', page);
        const r = await authed(`${cal(calendarId)}/events?${q.toString()}`, 'GET');
        if (!r.ok) return r;
        const items = rec(r.json)['items'];
        if (!Array.isArray(items)) return { ok: false, outcome: 'unknown', detail: 'calendar: events answer has no items' };
        for (const it of items) {
          const e = readEvent(it, timezone, from, to);
          if (e === null) return { ok: false, outcome: 'unknown', detail: 'calendar: an event has no id' };
          events.push(e);
        }
        const next = rec(r.json)['nextPageToken'];
        if (typeof next !== 'string' || next === '') return { ok: true, events };
        page = next;
      }
      return { ok: false, outcome: 'unknown', detail: 'calendar: more than ten pages of events in one window' };
    },

    async insert(calendarId, event) {
      const r = await authed(`${cal(calendarId)}/events`, 'POST', { id: event.id, ...eventBody(event) });
      if (!r.ok && r.status === 409) return { ok: false, outcome: 'exists' };
      return r.ok ? { ok: true } : r;
    },

    async patch(calendarId, eventId, event) {
      // `status: confirmed` brings back an event someone deleted by hand: the time is ours.
      const r = await authed(`${cal(calendarId)}/events/${encodeURIComponent(eventId)}`, 'PATCH', { ...eventBody(event), status: 'confirmed' });
      if (!r.ok && (r.status === 404 || r.status === 410)) return { ok: false, outcome: 'gone' };
      return r.ok ? { ok: true } : r;
    },

    async remove(calendarId, eventId) {
      const r = await authed(`${cal(calendarId)}/events/${encodeURIComponent(eventId)}`, 'DELETE');
      if (!r.ok && (r.status === 404 || r.status === 410)) return { ok: true };
      return r.ok ? { ok: true } : r;
    },
  };
}
