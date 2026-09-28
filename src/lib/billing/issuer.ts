/**
 * Who sends DalaTech's invoices, as the branded e-mail, the PDF invoice and the pay page
 * print it (D-156 addendum, 0070): the founder's full name, a phone, an e-mail, and the
 * Khan Bank account a client may transfer to instead of paying by QPay.
 *
 * These are the founder's own facts, not a client's, so they are platform settings rather
 * than rows. None is a secret. Read from the environment, NFC-normalised (rule 6), and
 * checked for shape, never defaulted: an invoice that prints a made-up account number sends
 * a client's money somewhere else.
 *
 *     BILLING_ISSUER_NAME    the founder's full name, as the invoice is signed
 *     BILLING_ISSUER_PHONE   the phone a client calls with a question
 *     BILLING_FOUNDER_EMAIL  (already set) the e-mail shown, and every e-mail's Reply-To
 *     BILLING_BANK_ACCOUNT   the Khan Bank account number
 *     BILLING_BANK_HOLDER    the name the account is held in, as the bank shows it
 *
 * While any is missing the platform keeps sending the plain e-mail it sent before 0070 and
 * tells the founder once why (`engine.ts`).
 */
export type Issuer = {
  name: string;
  phone: string;
  email: string;
  bankAccount: string;
  bankHolder: string;
};

export type IssuerOutcome = { ok: true; issuer: Issuer } | { ok: false; missing: string[] };

const PHONE_RE = /^\+?[0-9][0-9 -]{5,18}[0-9]$/u;
const ACCOUNT_RE = /^[0-9A-Z][0-9A-Z ]{4,32}[0-9A-Z]$/u;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/u;

function read(env: Readonly<Record<string, string | undefined>>, name: string): string | null {
  const v = env[name];
  if (v === undefined) return null;
  const t = v.normalize('NFC').trim();
  return t === '' ? null : t;
}

/** The settings as the environment holds them, each read by name (`check-env-example`). */
function processSettings(): Record<string, string | undefined> {
  return {
    BILLING_ISSUER_NAME: process.env['BILLING_ISSUER_NAME'],
    BILLING_ISSUER_PHONE: process.env['BILLING_ISSUER_PHONE'],
    BILLING_FOUNDER_EMAIL: process.env['BILLING_FOUNDER_EMAIL'],
    BILLING_BANK_ACCOUNT: process.env['BILLING_BANK_ACCOUNT'],
    BILLING_BANK_HOLDER: process.env['BILLING_BANK_HOLDER'],
  };
}

/** The issuer, or the names of the settings that are missing or malformed. Never throws. */
export function issuerFromEnv(env: Readonly<Record<string, string | undefined>> = processSettings()): IssuerOutcome {
  const missing: string[] = [];
  const name = read(env, 'BILLING_ISSUER_NAME');
  const phone = read(env, 'BILLING_ISSUER_PHONE');
  const email = read(env, 'BILLING_FOUNDER_EMAIL');
  const bankAccount = read(env, 'BILLING_BANK_ACCOUNT');
  const bankHolder = read(env, 'BILLING_BANK_HOLDER');
  if (name === null || [...name].length > 80) missing.push('BILLING_ISSUER_NAME');
  if (phone === null || !PHONE_RE.test(phone)) missing.push('BILLING_ISSUER_PHONE');
  if (email === null || !EMAIL_RE.test(email)) missing.push('BILLING_FOUNDER_EMAIL');
  if (bankAccount === null || !ACCOUNT_RE.test(bankAccount)) missing.push('BILLING_BANK_ACCOUNT');
  if (bankHolder === null || [...bankHolder].length > 80) missing.push('BILLING_BANK_HOLDER');
  if (missing.length > 0 || name === null || phone === null || email === null || bankAccount === null || bankHolder === null) {
    return { ok: false, missing };
  }
  return { ok: true, issuer: { name, phone, email, bankAccount, bankHolder } };
}

/** `tel:` form of the phone: digits and a leading +, nothing else. */
export function telHref(phone: string): string {
  return `tel:${phone.replace(/[^0-9+]/gu, '')}`;
}
