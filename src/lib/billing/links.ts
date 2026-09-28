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

export type Links = {
  pay(invoiceId: string): string;
  callback(invoiceId: string): string;
  action(kind: 'pause' | 'resume', accountId: string, invoiceId: string | null, now: Date): string;
};

/** Link builders over one origin (`DALA_PUBLIC_URL`) and one secret. */
export function linksFor(origin: string, secret: string): Links {
  const base = origin.replace(/\/+$/u, '');
  return {
    pay: (invoiceId) => `${base}/pay/${signLink(secret, { k: 'pay', id: invoiceId, exp: 0 })}`,
    callback: (invoiceId) =>
      `${base}/api/billing/qpay?t=${signLink(secret, { k: 'callback', id: invoiceId, exp: 0 })}`,
    action: (kind, accountId, invoiceId, now) => {
      const exp = Math.floor(now.getTime() / 1000) + ACTION_TTL_DAYS * 86_400;
      const claims: LinkClaims = { k: kind, id: accountId, exp, ...(invoiceId === null ? {} : { inv: invoiceId }) };
      return `${base}/billing/action?t=${signLink(secret, claims)}`;
    },
  };
}
