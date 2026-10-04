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
 *
 * ## The website's holds (`sh…`) and ours (`dh…`)
 *
 * Both sides hold a time with an opaque event before a QR exists. The website's contract
 * (matrix_website `services/bookingHold.js`, 2026-10-03): id `sh` + 40 hex characters (Google
 * event ids are base32hex, `0-9a-v`, so never `w`), private properties `{ taraHold: '1',
 * holdExpiresAt, holdPlacedAt, holdPhone }` (`holdPlacedAt` rewritten on every insert or
 * renewal), deleted once paid or lazily once expired. Ours: `dh` + the hold's uuid hex, «placed»
 * at the event's own `created`. Here:
 *
 *  - An EXPIRED website hold is free time (`isExpiredWebsiteHold`): `busy()` takes it out of
 *    Google's free/busy, which keeps showing it until the website deletes it.
 *  - Two holds on one time: the EARLIER-PLACED wins, on both sides. After writing its own hold,
 *    each side looks again and gives its hold back for any other blocking event, except a hold
 *    placed strictly later than its own (that one sees ours and yields). `otherBlocking` is our
 *    half: a website hold is placed at its `holdPlacedAt` (else its `created`), ours at `created`.
 */
import { createSign } from 'node:crypto';
import { localDayStart } from '../time/clock.ts';
import type { Interval } from './slots.ts';

export const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/calendar';
const TIMEOUT_MS = 10_000;

export type CalendarFailure = { ok: false; outcome: 'refused' | 'unknown'; detail: string; status?: number };

/**
 * An event as far as availability cares: what it is, when, and whether it blocks time. `created`:
 * Google's own stamp (null when absent). `hold`: a website hold (`sh`, with its expiry and placing time, null when
 * unreadable), one of ours (`dh`), or not a hold.
 */
export type CalendarEvent = {
  id: string; cancelled: boolean; blocks: boolean; start: Date; end: Date; created: Date | null;
  hold: { kind: 'website'; expiresAt: Date | null; placedAt: Date | null } | { kind: 'chat' } | null;
};

/** The website's hold id prefix (its contract; base32hex like every Google event id); ours is `dh` (`eventIdForHold`). */
export const WEBSITE_HOLD_PREFIX = 'sh';
export const CHAT_HOLD_PREFIX = 'dh';

/** A website hold whose QR has run out: free. An unreadable expiry is never read as expired. */
export function isExpiredWebsiteHold(e: CalendarEvent, now: Date): boolean {
  return e.hold !== null && e.hold.kind === 'website' && e.hold.expiresAt !== null && e.hold.expiresAt.getTime() <= now.getTime();
}

/** When a hold was placed: a website hold's `holdPlacedAt` (else its `created`), any other event's `created`. */
export function placedAt(e: CalendarEvent): Date | null {
  return e.hold !== null && e.hold.kind === 'website' ? e.hold.placedAt ?? e.created : e.created;
}

/**
 * The events that take [start, end) from our hold `ownId`, read after writing it: every blocking
 * event overlapping it, except our own, an expired website hold, and a hold (either side's) placed
 * strictly after ours, which yields to ours. Our own placing time unknown: no exception at all
 * (we yield to every other hold: never two winners). A tie: we yield (so may the other side).
 */
export function otherBlocking(events: readonly CalendarEvent[], ownId: string, start: Date, end: Date, now: Date): CalendarEvent[] {
  const own = events.find((e) => e.id === ownId);
  const ours = own === undefined ? null : placedAt(own);
  return events.filter((e) => {
    if (!e.blocks || e.id === ownId || !(e.start.getTime() < end.getTime() && start.getTime() < e.end.getTime())) return false;
    if (isExpiredWebsiteHold(e, now)) return false;
    const theirs = placedAt(e);
    return !(e.hold !== null && ours !== null && theirs !== null && theirs.getTime() > ours.getTime());
  });
}

/** [a, b) minus every interval in `cut`, in order. */
function subtract(a: Interval, cut: readonly Interval[]): Interval[] {
  let pieces: Interval[] = [a];
  for (const c of cut) {
    pieces = pieces.flatMap((p) => {
      if (c.end.getTime() <= p.start.getTime() || p.end.getTime() <= c.start.getTime()) return [p];
      const out: Interval[] = [];
      if (p.start.getTime() < c.start.getTime()) out.push({ start: p.start, end: c.start });
      if (c.end.getTime() < p.end.getTime()) out.push({ start: c.end, end: p.end });
      return out;
    });
  }
  return pieces;
}

/**
 * Google's busy intervals with every expired website hold taken out, and every other blocking
 * event put back (free/busy merges overlapping events, so cutting a hold out may cut a booking
 * that overlapped it). Pure.
 */
export function withoutExpiredHolds(busy: readonly Interval[], events: readonly CalendarEvent[], now: Date, from: Date, to: Date): Interval[] {
  const expired = events.filter((e) => isExpiredWebsiteHold(e, now)).map((e) => ({ start: e.start, end: e.end }));
  if (expired.length === 0) return [...busy];
  const kept = busy.flatMap((b) => subtract(b, expired));
  const back = events.filter((e) => e.blocks && !isExpiredWebsiteHold(e, now))
    .map((e) => ({ start: new Date(Math.max(e.start.getTime(), from.getTime())), end: new Date(Math.min(e.end.getTime(), to.getTime())) }))
    .filter((i) => i.start.getTime() < i.end.getTime());
  const sorted = [...kept, ...back].sort((x, y) => x.start.getTime() - y.start.getTime());
  // Merged again, as free/busy answers: overlapping or touching intervals are one.
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && i.start.getTime() <= last.end.getTime()) {
      if (i.end.getTime() > last.end.getTime()) out[out.length - 1] = { start: last.start, end: i.end };
    } else out.push(i);
  }
  return out;
}

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
  /**
   * Busy intervals per calendar over [from, to), an expired website hold counting as free. Any
   * calendar Google cannot answer: failure. `timezone` reads all-day events.
   */
  busy(calendarIds: readonly string[], from: Date, to: Date, timezone: string): Promise<{ ok: true; busy: Map<string, Interval[]> } | CalendarFailure>;
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
 * own ids begin `qb`/`qp` (bookings) and `sh` (its holds), so the two can never collide. `d`, `h`
 * and hex digits are all inside base32hex, so the id is a valid Google event id.
 */
export function eventIdForHold(holdId: string): string {
  const hex = holdId.toLowerCase().replace(/-/gu, '');
  if (!/^[0-9a-f]{32}$/u.test(hex)) throw new RangeError('a hold id is a uuid');
  const id = `${CHAT_HOLD_PREFIX}${hex}`;
  if (!/^[0-9a-v]{5,1024}$/u.test(id)) throw new RangeError('not a base32hex event id');
  return id;
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
  const createdAt = typeof r['created'] === 'string' ? new Date(r['created']) : null;
  const created = createdAt !== null && !Number.isNaN(createdAt.getTime()) ? createdAt : null;
  const priv = rec(rec(r['extendedProperties'])['private']);
  let hold: CalendarEvent['hold'] = null;
  const when = (v: unknown): Date | null => {
    const d = typeof v === 'string' ? new Date(v) : null;
    return d !== null && !Number.isNaN(d.getTime()) ? d : null;
  };
  if (id.startsWith(WEBSITE_HOLD_PREFIX) && priv['taraHold'] === '1') {
    hold = { kind: 'website', expiresAt: when(priv['holdExpiresAt']), placedAt: when(priv['holdPlacedAt']) };
  } else if (priv['dalaBookingState'] === 'hold') {
    // Ours, by its state, never by its `dh` id: a paid booking keeps the id and becomes
    // `dalaBookingState: 'booking'`, which is a booking (it always wins), not a hold.
    hold = { kind: 'chat' };
  }
  return { id, cancelled, blocks, start, end, created, hold };
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

  const port: CalendarPort = {
    async busy(calendarIds, from, to, timezone) {
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
      // Free/busy cannot tell a hold from a booking: read each calendar's events too, and take
      // the expired website holds out. Every read must answer, as above.
      const lists = await Promise.all(calendarIds.map((id) => port.events(id, from, to, timezone)));
      for (const [i, id] of calendarIds.entries()) {
        const l = lists[i];
        if (l === undefined || !l.ok) return l ?? { ok: false, outcome: 'unknown', detail: 'calendar: events unread' };
        out.set(id, withoutExpiredHolds(out.get(id) ?? [], l.events, now(), from, to));
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
  return port;
}
