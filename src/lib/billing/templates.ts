/**
 * The Mongolian DalaTech sends its clients: invoice, reminders, receipt, the pay page, and
 * the wording of computed invoice lines (D-156).
 *
 * Every sentence is a signed platform block (`prompt_blocks`, scope `platform`, layer null
 * so the prompt compiler never renders it), exactly as the data-deletion page's are
 * (`privacy/statusPage.ts`). There is no fallback string anywhere in this path: a missing
 * or unsigned block means the message is not sent and the founder is told, because a
 * fallback is how unreviewed Mongolian reaches a client. The drafts are in
 * `prompt/drafts/billing/`; `scripts/prompt/sign-drafts.ts --dir prompt/drafts/billing` signs
 * them, and the seed migration it writes is what makes them readable here.
 *
 * The one exception is a TEST account, whose only recipient is the founder: the operator's
 * `scripts/billing/tick.ts --drafts` may hand it the unsigned drafts so the wording can be
 * judged in a real inbox. Deployed code never reads a draft.
 *
 * ## Placeholders are checked, both ways
 *
 * `{name}` is replaced by a value. A block that uses a name this module does not supply, or
 * leaves out one it must carry (the amount, the pay link), refuses to render: an invoice
 * with no amount on it, or with `{amount}` printed literally, is worse than none.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

type Spec = { required: readonly string[]; optional: readonly string[] };

const MESSAGE: Spec = { required: ['client', 'invoice_no', 'amount', 'lines', 'due_date', 'pay_link'], optional: ['period'] };
const SUBJECT: Spec = { required: ['invoice_no'], optional: ['period', 'client'] };

export const BILLING_BLOCKS = {
  billing_invoice_subject: SUBJECT,
  billing_invoice_body: MESSAGE,
  billing_reminder_before_subject: SUBJECT,
  billing_reminder_before_body: MESSAGE,
  billing_reminder_after_subject: SUBJECT,
  billing_reminder_after_body: MESSAGE,
  billing_receipt_subject: SUBJECT,
  billing_receipt_body: { required: ['client', 'invoice_no', 'amount', 'paid_date'], optional: ['period', 'pay_link'] },
  billing_period_month: { required: ['year', 'month'], optional: [] },
  billing_period_range: { required: ['start', 'end'], optional: [] },
  billing_page_title: { required: [], optional: ['invoice_no'] },
  billing_page_amount: { required: [], optional: [] },
  billing_page_due: { required: [], optional: [] },
  billing_page_covers: { required: [], optional: [] },
  billing_page_status_open: { required: [], optional: [] },
  billing_page_status_paid: { required: [], optional: ['paid_date'] },
  billing_page_status_other: { required: [], optional: [] },
  billing_page_scan: { required: [], optional: [] },
  billing_page_banks: { required: [], optional: [] },
  // 0068: the countdown under the QR, and what replaces it when it expires. Word for word the
  // lines the founder approved for Tara's booking QR (matrix_website/script.js).
  billing_page_qr_valid: { required: ['time'], optional: [] },
  billing_page_qr_expired: { required: [], optional: [] },
  billing_page_qr_renew: { required: [], optional: [] },
  // Past the hourly cap on new codes (a link opened again and again): a draft of its own.
  billing_page_qr_wait: { required: [], optional: [] },
  // 0070: the branded e-mail, the PDF invoice and the pay page's new parts. Each piece is its
  // own block so the layout (table, button, bank box) is the platform's and the words are
  // the founder's. `{phone}` etc. are the issuer's settings (`issuer.ts`).
  billing_mail_invoice_title: { required: ['invoice_no'], optional: [] },
  billing_mail_invoice_intro: { required: ['client'], optional: ['period', 'due_date'] },
  billing_mail_reminder_before_title: { required: [], optional: ['invoice_no'] },
  billing_mail_reminder_before_intro: { required: ['client', 'due_date'], optional: ['period'] },
  billing_mail_reminder_after_title: { required: [], optional: ['invoice_no'] },
  billing_mail_reminder_after_intro: { required: ['client', 'due_date'], optional: ['period'] },
  billing_mail_receipt_title: { required: [], optional: ['invoice_no'] },
  billing_mail_receipt_intro: { required: ['client'], optional: ['period'] },
  billing_mail_closing: { required: ['phone'], optional: [] },
  billing_mail_receipt_closing: { required: ['phone'], optional: [] },
  billing_mail_signoff: { required: [], optional: [] },
  billing_pay_button: { required: [], optional: [] },
  billing_bank_title: { required: [], optional: [] },
  billing_bank_intro: { required: [], optional: ['invoice_no'] },
  billing_bank_name: { required: [], optional: [] },
  billing_label_invoice_no: { required: [], optional: [] },
  billing_label_contract_no: { required: [], optional: [] },
  billing_label_payer: { required: [], optional: [] },
  billing_label_issuer: { required: [], optional: [] },
  billing_label_issued_on: { required: [], optional: [] },
  billing_label_service: { required: [], optional: [] },
  billing_label_amount: { required: [], optional: [] },
  billing_label_total: { required: [], optional: [] },
  billing_label_paid_amount: { required: [], optional: [] },
  billing_label_paid_on: { required: [], optional: [] },
  billing_label_phone: { required: [], optional: [] },
  billing_label_email: { required: [], optional: [] },
  billing_label_bank: { required: [], optional: [] },
  billing_label_account: { required: [], optional: [] },
  billing_label_holder: { required: [], optional: [] },
  billing_label_reference: { required: [], optional: [] },
  billing_doc_title: { required: [], optional: [] },
  billing_doc_signature: { required: [], optional: [] },
  billing_doc_vat: { required: [], optional: [] },
  billing_page_questions: { required: ['phone'], optional: [] },
  billing_line_months: { required: ['label', 'months'], optional: [] },
  billing_line_team_discount: { required: ['count', 'percent'], optional: [] },
  billing_line_annual_free: { required: ['months'], optional: [] },
  // 2026-10-02: Ора's e-mail layout (`mail.ts`). Optional parts of the e-mail: while one is
  // not signed, a client's e-mail leaves it out rather than refusing (MAIL_OPTIONAL_KEYS).
  billing_mail_fallback_link: { required: [], optional: [] },
  billing_mail_footer_why: { required: [], optional: [] },
  billing_mail_footer_contact_label: { required: [], optional: [] },
  // The pause notice (2026-10-02): sent once, after the founder pauses a client for an unpaid
  // invoice. Its own subject and body, and its own title and intro in the branded e-mail.
  billing_pause_subject: SUBJECT,
  // No {due_date}: by the time of a pause it has passed, and repeating it reads as a new deadline.
  billing_pause_body: { required: ['client', 'invoice_no', 'amount', 'lines', 'pay_link'], optional: ['period'] },
  billing_mail_pause_title: { required: [], optional: ['invoice_no'] },
  billing_mail_pause_intro: { required: ['client'], optional: ['period', 'due_date'] },
} as const satisfies Record<string, Spec>;

export type BillingBlockKey = keyof typeof BILLING_BLOCKS;
export const BILLING_BLOCK_KEYS = Object.keys(BILLING_BLOCKS) as BillingBlockKey[];

/** Where the wording came from. `draft` only ever reaches a test account. */
export type Wording = { source: 'signed' | 'draft'; blocks: ReadonlyMap<string, string> };

export type WordingOutcome =
  | { ok: true; wording: Wording }
  | { ok: false; reason: 'unavailable'; detail: string };

/** The signed billing blocks. Some may be missing; `render` refuses per message. */
export async function loadSignedWording(db: SupabaseClient): Promise<WordingOutcome> {
  const { data, error } = await db
    .from('prompt_blocks')
    .select('block_key, body')
    .eq('scope', 'platform')
    .is('tenant_id', null)
    .not('reviewed_at', 'is', null)
    .in('block_key', BILLING_BLOCK_KEYS);
  if (error) return { ok: false, reason: 'unavailable', detail: `prompt_blocks unreadable: ${error.message}` };
  const blocks = new Map<string, string>();
  for (const row of Array.isArray(data) ? data : []) {
    const r = row as Record<string, unknown>;
    const body = typeof r['body'] === 'string' ? r['body'].trim() : '';
    if (body !== '') blocks.set(String(r['block_key']), body);
  }
  return { ok: true, wording: { source: 'signed', blocks } };
}

export type Rendered = { ok: true; text: string } | { ok: false; why: string };

/** Render one block with exactly its placeholders. Values are NFC-normalised (rule 6). */
export function render(wording: Wording, key: BillingBlockKey, values: Readonly<Record<string, string>>): Rendered {
  const body = wording.blocks.get(key);
  if (body === undefined) return { ok: false, why: `${key} is not signed` };
  const spec: Spec = BILLING_BLOCKS[key];
  const used = new Set([...body.matchAll(/\{([^{}\s]+)\}/gu)].map((m) => m[1] as string));
  for (const name of used) {
    if (!spec.required.includes(name) && !spec.optional.includes(name)) {
      return { ok: false, why: `${key} uses {${name}}, which is not one of its placeholders` };
    }
  }
  for (const name of spec.required) {
    if (!used.has(name)) return { ok: false, why: `${key} must contain {${name}}` };
  }
  for (const name of used) {
    if (values[name] === undefined) return { ok: false, why: `${key}: no value for {${name}}` };
  }
  const text = body.replace(/\{([^{}\s]+)\}/gu, (_, name: string) => (values[name] as string).normalize('NFC'));
  return { ok: true, text: text.normalize('NFC') };
}

/** «250,000₮». Digits grouped by three, the tugrik sign trailing, as the price rows write it. */
export function formatMnt(amount: number): string {
  if (!Number.isInteger(amount)) throw new RangeError(`not a whole tugrik amount: ${amount}`);
  const sign = amount < 0 ? '−' : '';
  const digits = String(Math.abs(amount));
  let out = '';
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return `${sign}${out}₮`;
}

export type InvoiceLine = { label: string; amount_mnt: number };

/** The invoice's lines as the client reads them: one per row, label then amount. */
export function renderLines(lines: readonly InvoiceLine[]): string {
  return lines.map((l) => `• ${l.label}: ${formatMnt(l.amount_mnt)}`).join('\n');
}
