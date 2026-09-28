/**
 * Billing's environment, read in one place (D-156).
 *
 * `BILLING_MODE` is the founder's switch, and the only one:
 *
 * - unset or `off` — every billing surface answers "disabled" and touches nothing.
 * - `test` — only `is_test` accounts are invoiced, checked, reminded or summarised.
 * - `live` — every active REAL account with a confirmed schedule, and never a test account
 *   (0070: the modes partition the accounts). **Setting this is the
 *   founder's approval of the first real run**; `scripts/billing/report.ts preview` shows
 *   beforehand exactly which invoices that run will create.
 *
 * Any other value refuses (a `LIVE` or `true` that silently meant off, or silently meant
 * on, is the failure a switch must not have); preflight refuses it at deploy time too.
 */
import { required } from '../env.ts';
import type { QpayConfig } from './qpay.ts';

export type BillingSwitch = 'off' | 'test' | 'live';

export function billingSwitch(): BillingSwitch {
  const v = process.env['BILLING_MODE'];
  if (v === undefined || v === '' || v === 'off') return 'off';
  if (v === 'test' || v === 'live') return v;
  throw new Error(`BILLING_MODE must be off, test or live, not ${JSON.stringify(v)}. Refusing rather than guessing.`);
}

/** Core Language's QPay credentials, copied under the same names (founder, 2026-09-28). */
export function qpayConfigFromEnv(): QpayConfig {
  return {
    username: required('QPAY_USERNAME').trim(),
    password: required('QPAY_PASSWORD').trim(),
    terminalId: required('QPAY_TERMINAL_ID').trim(),
    merchantId: required('QPAY_MERCHANT_ID').trim(),
    bankCode: required('QPAY_BANK_CODE').trim(),
    bankAccount: required('QPAY_BANK_ACCOUNT').trim(),
    accountName: required('QPAY_ACCOUNT_NAME').trim(),
  };
}

/** The origin every billing link is built on: the deployment's public origin. */
export function billingOrigin(): string {
  return required('DALA_PUBLIC_URL');
}

/**
 * The host the short pay address is printed on (`BILLING_PAY_ORIGIN`, e.g.
 * https://pay.dalatech.online), or null: then it is `DALA_PUBLIC_URL/pay/<ref>`. Set it only
 * once that host answers (its DNS points at this project); an address in a sent e-mail
 * cannot be changed afterwards.
 */
export function billingPayOrigin(): string | null {
  const v = process.env['BILLING_PAY_ORIGIN'];
  if (v === undefined || v.trim() === '') return null;
  const u = new URL(v.trim());
  if (u.protocol !== 'https:' || u.pathname !== '/' || u.search !== '' || u.hash !== '') {
    throw new Error('BILLING_PAY_ORIGIN must be an https origin with no path, e.g. https://pay.dalatech.online');
  }
  return u.origin;
}

/**
 * Which provider sends client e-mail (`BILLING_EMAIL_VIA`): `brevo` (the default, as before
 * 0070) or `resend`. Brevo adds a List-Unsubscribe header to every message and does not
 * remove it on this plan, so Gmail shows an "Unsubscribe" link on an invoice; worse, a
 * client who presses it is blocklisted and their later invoices are accepted and dropped.
 * Resend adds no such header. `resend` needs `RESEND_API_KEY` for a Resend account on which
 * dalatech.online is verified.
 */
export function billingEmailVia(): 'brevo' | 'resend' {
  const v = process.env['BILLING_EMAIL_VIA'];
  if (v === undefined || v === '' || v === 'brevo') return 'brevo';
  if (v === 'resend') return 'resend';
  throw new Error(`BILLING_EMAIL_VIA must be brevo or resend, not ${JSON.stringify(v)}`);
}

export function billingLinkSecret(): string {
  const s = required('BILLING_LINK_SECRET');
  if (s.length < 32) throw new Error('BILLING_LINK_SECRET must be at least 32 characters');
  return s;
}

export function founderEmail(): string | null {
  const v = process.env['BILLING_FOUNDER_EMAIL'];
  return v === undefined || v.trim() === '' ? null : v.trim();
}
