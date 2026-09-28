/**
 * Billing's environment, read in one place (D-156).
 *
 * `BILLING_MODE` is the founder's switch, and the only one:
 *
 * - unset or `off` — every billing surface answers "disabled" and touches nothing.
 * - `test` — only `is_test` accounts are invoiced, checked, reminded or summarised.
 * - `live` — every active account with a confirmed schedule. **Setting this is the
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

export function billingLinkSecret(): string {
  const s = required('BILLING_LINK_SECRET');
  if (s.length < 32) throw new Error('BILLING_LINK_SECRET must be at least 32 characters');
  return s;
}

export function founderEmail(): string | null {
  const v = process.env['BILLING_FOUNDER_EMAIL'];
  return v === undefined || v.trim() === '' ? null : v.trim();
}
