/**
 * Signed links: the client's pay page, QPay's callback, and the founder's pause/resume tap.
 *
 * A link is `<payload>.<mac>`: the payload is base64url JSON naming what it opens, the mac
 * is HMAC-SHA256 under `BILLING_LINK_SECRET`. Nothing is stored, so the same link can be
 * rebuilt for every reminder, and a link cannot be forged or pointed at another invoice
 * without the secret. Rotating the secret invalidates every link ever sent — the recovery
 * for a leak, and the reason the secret is its own variable.
 *
 * - `pay` never expires: a client may open an old invoice to see that it was paid.
 * - `callback` never expires: QPay may call late, and the callback trusts nothing it is
 *   sent — it only makes the platform ask QPay itself (`engine.ts`).
 * - `pause` / `resume` expire (`ACTION_TTL_DAYS`): they change what a client's customers
 *   see, and they live in a Telegram chat. Opening one shows a confirmation page; only the
 *   page's POST acts, so a link preview or a prefetch cannot pause anybody.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type LinkKind = 'pay' | 'callback' | 'pause' | 'resume';

export type LinkClaims = {
  k: LinkKind;
  /** The invoice id (pay, callback) or the billing account id (pause, resume). */
  id: string;
  /** For pause/resume: the invoice that prompted it. */
  inv?: string;
  /** Unix seconds; 0 = never expires. */
  exp: number;
};

export const ACTION_TTL_DAYS = 14;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function mac(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function signLink(secret: string, claims: LinkClaims): string {
  if (secret.length < 32) throw new Error('BILLING_LINK_SECRET must be at least 32 characters');
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${payload}.${mac(secret, payload)}`;
}

/** The claims of a genuine, unexpired link of the expected kind, or null. Never throws. */
export function verifyLink(secret: string, token: string, kind: LinkKind, now: Date): LinkClaims | null {
  if (typeof token !== 'string' || token.length > 2000) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
  const payload = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), 'utf8');
  const want = Buffer.from(mac(secret, payload), 'utf8');
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const c = claims as Partial<LinkClaims>;
  if (c.k !== kind || typeof c.id !== 'string' || !UUID_RE.test(c.id)) return null;
  if (c.inv !== undefined && (typeof c.inv !== 'string' || !UUID_RE.test(c.inv))) return null;
  if (typeof c.exp !== 'number' || !Number.isInteger(c.exp) || c.exp < 0) return null;
  if (c.exp !== 0 && c.exp * 1000 < now.getTime()) return null;
  return { k: c.k, id: c.id, exp: c.exp, ...(c.inv === undefined ? {} : { inv: c.inv }) };
}

/**
 * Which action a link claims to be, read WITHOUT verifying it — only to choose which kind
 * `verifyLink` then checks it against. A forged kind fails that check like anything else.
 */
export function actionKindOf(token: string): 'pause' | 'resume' {
  try {
    const payload = token.slice(0, Math.max(0, token.indexOf('.')));
    const k = (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { k?: unknown }).k;
    return k === 'resume' ? 'resume' : 'pause';
  } catch {
    return 'pause';
  }
}

// ---------------------------------------------------------------------------------------
// The short pay address (0070): `pay.dalatech.online/DT-202610-0001-K7QM2X`
// ---------------------------------------------------------------------------------------
//
// What a client sees in an e-mail, on the PDF and on the phone: the invoice number they
// already know, and six characters that make it unguessable. Invoice numbers are sequential,
// so the number alone would let anyone read every client's name and amount by counting; the
// six characters are an HMAC of the invoice id under the same secret as the signed links
// (30 bits: a guess is one in a billion, per invoice). Nothing is stored: the code is
// recomputed and compared in constant time. Rotating `BILLING_LINK_SECRET` kills these too.
//
// Crockford's alphabet: no I, L, O or U, so a code read aloud or retyped from paper is not
// misread, and the page accepts it in either case.

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const REF_CODE_LENGTH = 6;
const PAY_REF_RE = /^((?:TEST|DT)-[0-9]{6}-[0-9]{4,9})-([0-9A-HJKMNP-TV-Z]{6})$/u;

/** The six characters for one invoice. */
export function payRefCode(secret: string, invoiceId: string): string {
  if (secret.length < 32) throw new Error('BILLING_LINK_SECRET must be at least 32 characters');
  const bytes = createHmac('sha256', secret).update(`pay-ref:${invoiceId}`).digest();
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5 && out.length < REF_CODE_LENGTH) {
      out += CROCKFORD[(acc >> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length === REF_CODE_LENGTH) break;
    acc &= (1 << bits) - 1;
  }
  return out;
}

export function payRef(secret: string, invoiceId: string, invoiceNo: string): string {
  return `${invoiceNo}-${payRefCode(secret, invoiceId)}`;
}

/** A short address's invoice number and code, or null when it is not one. Never throws. */
export function parsePayRef(ref: string): { invoiceNo: string; code: string } | null {
  if (typeof ref !== 'string' || ref.length > 40) return null;
  const m = PAY_REF_RE.exec(ref.toUpperCase());
  return m === null ? null : { invoiceNo: m[1] as string, code: m[2] as string };
}

/** Whether `code` is this invoice's, compared in constant time. */
export function payRefMatches(secret: string, invoiceId: string, code: string): boolean {
  const want = Buffer.from(payRefCode(secret, invoiceId), 'utf8');
  const given = Buffer.from(code.toUpperCase(), 'utf8');
  return given.length === want.length && timingSafeEqual(given, want);
}

export type Links = {
  /** The short pay address a client is given (e-mail, PDF, page). */
  pay(invoiceId: string, invoiceNo: string): string;
  callback(invoiceId: string): string;
  action(kind: 'pause' | 'resume', accountId: string, invoiceId: string | null, now: Date): string;
};

/**
 * Link builders over one origin (`DALA_PUBLIC_URL`) and one secret. `payOrigin` is the host
 * the short pay address is shown on (`BILLING_PAY_ORIGIN`, e.g. https://pay.dalatech.online,
 * where `next.config.mjs` maps `/<ref>` to `/pay/<ref>`); without it the address is
 * `<origin>/pay/<ref>`, which works on any host this app answers.
 */
export function linksFor(origin: string, secret: string, payOrigin?: string | null): Links {
  const base = origin.replace(/\/+$/u, '');
  const payBase = payOrigin === undefined || payOrigin === null || payOrigin === '' ? `${base}/pay` : payOrigin.replace(/\/+$/u, '');
  return {
    pay: (invoiceId, invoiceNo) => `${payBase}/${payRef(secret, invoiceId, invoiceNo)}`,
    callback: (invoiceId) =>
      `${base}/api/billing/qpay?t=${signLink(secret, { k: 'callback', id: invoiceId, exp: 0 })}`,
    action: (kind, accountId, invoiceId, now) => {
      const exp = Math.floor(now.getTime() / 1000) + ACTION_TTL_DAYS * 86_400;
      const claims: LinkClaims = { k: kind, id: accountId, exp, ...(invoiceId === null ? {} : { inv: invoiceId }) };
      return `${base}/billing/action?t=${signLink(secret, claims)}`;
    },
  };
}
