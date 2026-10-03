/**
 * Which QPay Quick QR login a tenant's deposits are invoiced on.
 *
 * What makes a branch's money its own is its MERCHANT and its PAYOUT ACCOUNT, both rows in its
 * `booking_config.qpay` and sent on every invoice. The login only says who asks QPay: by default
 * the platform's partner login (`QPAY_USERNAME`, `QPAY_PASSWORD`, `QPAY_TERMINAL_ID`, under which
 * each branch's merchant is registered). A tenant whose merchant lives under a login of its own
 * names it in the row (`qpay.login: "PARKOD"`), and then ONLY that login is used:
 * `BOOKING_QPAY_PARKOD_USERNAME`, `BOOKING_QPAY_PARKOD_PASSWORD`, `BOOKING_QPAY_PARKOD_TERMINAL_ID`.
 * All three or none; any missing refuses, and nothing ever falls back to the platform's login or
 * another tenant's. Secrets come from the environment only (rule 7) and are read per call, never
 * cached at module scope.
 */
import type { QpayMerchant } from './config.ts';

export type QpayLogin = { username: string; password: string; terminalId: string };

/** The environment names a merchant's login is read from. */
export function qpayLoginNames(m: Pick<QpayMerchant, 'login'>): { username: string; password: string; terminalId: string } {
  if (m.login === null) return { username: 'QPAY_USERNAME', password: 'QPAY_PASSWORD', terminalId: 'QPAY_TERMINAL_ID' };
  return {
    username: `BOOKING_QPAY_${m.login}_USERNAME`,
    password: `BOOKING_QPAY_${m.login}_PASSWORD`,
    terminalId: `BOOKING_QPAY_${m.login}_TERMINAL_ID`,
  };
}

/** The login for this merchant, or the names that are missing. `env` is the test seam. */
export function qpayLoginFor(
  m: Pick<QpayMerchant, 'login'>, env: Readonly<Record<string, string | undefined>> = process.env,
): { ok: true; login: QpayLogin } | { ok: false; missing: string[] } {
  const names = qpayLoginNames(m);
  const read = (k: string) => (env[k] ?? '').trim();
  const login = { username: read(names.username), password: read(names.password), terminalId: read(names.terminalId) };
  const missing = Object.entries(names).filter(([k]) => login[k as keyof QpayLogin] === '').map(([, v]) => v);
  return missing.length === 0 ? { ok: true, login } : { ok: false, missing };
}
