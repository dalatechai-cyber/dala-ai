/**
 * Signed addresses for one hold: the pay page a customer opens, and QPay's callback.
 *
 * `<hold id>.<hmac>`, the HMAC over a purpose and the id under `BOOKING_LINK_SECRET`. The two
 * purposes differ, so a callback token never opens the page and the reverse. Neither carries
 * anything a reader could use: the hold id is a random uuid, and the page shows only what the
 * customer already typed into their own chat.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type LinkPurpose = 'pay' | 'callback';
const MIN_SECRET = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function linkSecret(raw: string | undefined = process.env['BOOKING_LINK_SECRET']): string | null {
  const s = raw ?? '';
  return s.length >= MIN_SECRET ? s : null;
}

function mac(secret: string, purpose: LinkPurpose, holdId: string): string {
  return createHmac('sha256', secret).update(`booking-${purpose}:${holdId}`).digest('hex').slice(0, 32);
}

export function signHold(secret: string, purpose: LinkPurpose, holdId: string): string {
  if (!UUID.test(holdId)) throw new RangeError('a hold id is a uuid');
  return `${holdId}.${mac(secret, purpose, holdId)}`;
}

/** The hold id a token names, or null. Constant-time on the signature. */
export function verifyHold(secret: string, purpose: LinkPurpose, token: string): string | null {
  const m = /^([0-9a-f-]{36})\.([0-9a-f]{32})$/u.exec(token.trim().toLowerCase());
  if (m === null || !UUID.test(m[1] as string)) return null;
  const want = Buffer.from(mac(secret, purpose, m[1] as string));
  const got = Buffer.from(m[2] as string);
  return want.length === got.length && timingSafeEqual(want, got) ? (m[1] as string) : null;
}

/** `https://api.dalatech.online` and the like: the deployment's public origin, no path. */
export function publicOrigin(value: string | undefined = process.env['DALA_PUBLIC_URL']): string | null {
  const raw = (value ?? '').trim();
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

export function payUrl(origin: string, secret: string, holdId: string): string {
  return `${origin}/book/${signHold(secret, 'pay', holdId)}`;
}

export function callbackUrl(origin: string, secret: string, holdId: string): string {
  return `${origin}/api/booking/qpay?t=${signHold(secret, 'callback', holdId)}`;
}
