/**
 * The branded client e-mail (0070): invoice, the two reminders and the receipt, as a real
 * company's invoice looks — DalaTech's mark and colours, a clean invoice table, one
 * «Төлбөр төлөх» button to the short pay address, the Khan Bank alternative, and a footer
 * with the founder's name, phone, e-mail and account. A plain-text version carries the same
 * content line by line; the invoice and reminders attach the PDF (`pdf.ts`).
 *
 * Every word is a signed block (`templates.ts`); the layout is the platform's. Values are
 * escaped for HTML. It is TRANSACTIONAL: no unsubscribe link, no marketing footer, no
 * tracking pixel, no remote font (a mail client that blocks images still shows everything
 * but the mark). Light background: dark e-mails invert unpredictably in Outlook and Gmail.
 *
 * `mailReady` says whether the branded version can be sent at all (every block signed, the
 * issuer's settings present). While it cannot, the engine sends the pre-0070 plain e-mail.
 */
import { billingToday, dottedDay } from './calendar.ts';
import type { Account, Invoice } from './engine.ts';
import type { Issuer } from './issuer.ts';
import { telHref } from './issuer.ts';
import { formatMnt, render, type BillingBlockKey, type Wording } from './templates.ts';

export type MailKind = 'invoice' | 'reminder_before' | 'reminder_after' | 'receipt';

/** The brand, from dalatech.online's own stylesheet. */
export const BRAND = {
  // The mark's own background, so the logo sits on the band without a visible square.
  navy: '#050A18',
  navyDeep: '#060E24',
  blue: '#2563EB',
  sky: '#38BDF8',
  ink: '#0F172A',
  muted: '#5A6E94',
  line: '#E3E8F2',
  paper: '#F4F6FB',
  soft: '#F0F4FF',
} as const;

const TITLE: Record<MailKind, BillingBlockKey> = {
  invoice: 'billing_mail_invoice_title',
  reminder_before: 'billing_mail_reminder_before_title',
  reminder_after: 'billing_mail_reminder_after_title',
  receipt: 'billing_mail_receipt_title',
};
const INTRO: Record<MailKind, BillingBlockKey> = {
  invoice: 'billing_mail_invoice_intro',
  reminder_before: 'billing_mail_reminder_before_intro',
  reminder_after: 'billing_mail_reminder_after_intro',
  receipt: 'billing_mail_receipt_intro',
};

/** The blocks shared by the e-mail and the PDF, whatever the kind. */
export const DOC_KEYS = [
  'billing_label_invoice_no', 'billing_label_contract_no', 'billing_label_payer', 'billing_label_issuer',
  'billing_label_issued_on', 'billing_page_due', 'billing_label_service', 'billing_label_amount', 'billing_label_total',
  'billing_label_phone', 'billing_label_email', 'billing_label_bank', 'billing_label_account', 'billing_label_holder',
  'billing_label_reference', 'billing_bank_title', 'billing_bank_intro', 'billing_bank_name', 'billing_pay_button',
  'billing_doc_title', 'billing_doc_signature', 'billing_doc_vat',
] as const satisfies readonly BillingBlockKey[];

/** Every block the branded e-mails need. */
export const MAIL_KEYS: readonly BillingBlockKey[] = [
  ...DOC_KEYS, ...Object.values(TITLE), ...Object.values(INTRO),
  'billing_mail_closing', 'billing_mail_receipt_closing', 'billing_mail_signoff',
  'billing_label_paid_amount', 'billing_label_paid_on',
];

export function mailReady(wording: Wording, issuer: { ok: true } | { ok: false; missing: string[] }): { ok: true } | { ok: false; why: string } {
  const unsigned = MAIL_KEYS.filter((k) => !wording.blocks.has(k));
  if (unsigned.length > 0) return { ok: false, why: `${unsigned.length} block(s) of the branded e-mail are not signed (${unsigned.slice(0, 3).join(', ')}${unsigned.length > 3 ? ', …' : ''})` };
  if (!issuer.ok) return { ok: false, why: `these settings are missing or malformed: ${issuer.missing.join(', ')}` };
  return { ok: true };
}

export type MailInput = {
  kind: MailKind;
  wording: Wording;
  invoice: Invoice;
  account: Pick<Account, 'displayName'> & { contractRef: string | null };
  issuer: Issuer;
  /** The short pay address. */
  payUrl: string;
  /** `billing_period_month` / `_range` already rendered, or the first line's label. */
  period?: string;
  /** The mark, as an absolute https URL on this deployment. */
  logoUrl: string;
};

export type RenderedMail = { ok: true; text: string; html: string } | { ok: false; why: string };

export function esc(s: string): string {
  return s.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&#39;');
}

/** The address as shown: no scheme, so it reads as an address, not as a long link. */
export function shownAddress(url: string): string {
  return url.replace(/^https:\/\//u, '');
}

/** A renderer that throws on a block that will not render; `renderMail` turns that into a refusal. */
class Refused extends Error {}
function words(w: Wording, values: Record<string, string>) {
  return (key: BillingBlockKey, extra: Record<string, string> = {}): string => {
    const r = render(w, key, { ...values, ...extra });
    if (!r.ok) throw new Refused(r.why);
    return r.text;
  };
}

/** Paragraphs of a block: blank lines split, single newlines kept as <br>. */
function paragraphs(text: string, style: string): string {
  return text.split(/\n{2,}/u).map((p) => `<p style="${style}">${esc(p).replace(/\n/gu, '<br>')}</p>`).join('');
}

const FONT = `font-family:Inter,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;

function row(label: string, value: string, opts: { strong?: boolean; last?: boolean } = {}): string {
  const border = opts.last === true ? '' : `border-bottom:1px solid ${BRAND.line};`;
  return `<tr><td style="padding:10px 0;${border}color:${BRAND.muted};font-size:14px;${FONT}">${esc(label)}</td>`
    + `<td align="right" style="padding:10px 0;${border}color:${BRAND.ink};font-size:14px;${FONT};${opts.strong === true ? 'font-weight:700;' : ''}">${esc(value)}</td></tr>`;
}

function table(inner: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">${inner}</table>`;
}

export function renderMail(input: MailInput): RenderedMail {
  const { kind, invoice: inv, account, issuer } = input;
  const receipt = kind === 'receipt';
  const paidAmount = inv.paidSumMnt > 0 ? inv.paidSumMnt : inv.amountMnt;
  const values: Record<string, string> = {
    client: account.displayName,
    invoice_no: inv.invoiceNo,
    due_date: dottedDay(inv.dueOn),
    phone: issuer.phone,
    ...(input.period === undefined ? {} : { period: input.period }),
  };
  try {
    const t = words(input.wording, values);
    const title = t(TITLE[kind]);
    const intro = t(INTRO[kind]);
    const closing = t(receipt ? 'billing_mail_receipt_closing' : 'billing_mail_closing');
    const draft = input.wording.source === 'draft';

    // The facts, in the order a bookkeeper reads them.
    const facts: Array<[string, string]> = [
      [t('billing_label_invoice_no'), inv.invoiceNo],
      ...(account.contractRef === null ? [] : [[t('billing_label_contract_no'), account.contractRef] as [string, string]]),
      [t('billing_label_payer'), account.displayName],
      [t('billing_label_issued_on'), dottedDay(inv.issuedOn)],
      ...(receipt
        ? [[t('billing_label_paid_on'), inv.paidAt === null ? '' : dottedDay(billingToday(inv.paidAt))] as [string, string]]
        : [[t('billing_page_due'), dottedDay(inv.dueOn)] as [string, string]]),
    ];
    const totalLabel = receipt ? t('billing_label_paid_amount') : t('billing_label_total');
    const totalAmount = formatMnt(receipt ? paidAmount : inv.amountMnt);
    const bank: Array<[string, string]> = [
      [t('billing_label_bank'), t('billing_bank_name')],
      [t('billing_label_account'), issuer.bankAccount],
      [t('billing_label_holder'), issuer.bankHolder],
      [t('billing_label_reference'), inv.invoiceNo],
      [t('billing_label_amount'), formatMnt(inv.amountMnt)],
    ];
    const signoff = t('billing_mail_signoff');
    const button = t('billing_pay_button');
    const vat = t('billing_doc_vat');

    // ---- plain text ----
    const text = [
      ...(draft ? ['[TEST — unsigned draft wording]', ''] : []),
      title, '',
      intro, '',
      ...facts.map(([l, v]) => `${l}: ${v}`), '',
      `${t('billing_label_service')}:`,
      ...inv.lines.map((l) => `• ${l.label}: ${formatMnt(l.amount_mnt)}`),
      `${totalLabel}: ${totalAmount}`, '',
      ...(receipt ? [vat, ''] : [
        `${button}: ${input.payUrl}`, '',
        `${t('billing_bank_title')}`, t('billing_bank_intro'),
        ...bank.map(([l, v]) => `${l}: ${v}`), '',
      ]),
      closing, '',
      signoff, issuer.name, 'DalaTech', '',
      '—',
      `${issuer.name} · DalaTech`,
      `${t('billing_label_phone')}: ${issuer.phone} · ${t('billing_label_email')}: ${issuer.email}`,
      `${t('billing_bank_name')}: ${issuer.bankAccount} (${issuer.bankHolder})`,
    ].join('\n');

    // ---- HTML ----
    const p = `margin:0 0 14px;color:${BRAND.ink};font-size:15px;line-height:1.6;${FONT}`;
    const lineRows = inv.lines.map((l) => row(l.label, formatMnt(l.amount_mnt))).join('');
    const payBlock = receipt ? '' :
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:8px 0 4px">`
      + `<a href="${esc(input.payUrl)}" style="display:inline-block;background:${BRAND.blue};color:#FFFFFF;text-decoration:none;font-weight:700;font-size:16px;${FONT};padding:14px 36px;border-radius:10px">${esc(button)}</a>`
      + `</td></tr><tr><td align="center" style="padding:6px 0 0;color:${BRAND.muted};font-size:12px;${FONT}">${esc(shownAddress(input.payUrl))}</td></tr></table>`;
    const bankBlock = receipt ? '' :
      `<div style="margin:24px 0 0;padding:16px 18px;background:${BRAND.soft};border-radius:12px">`
      + `<p style="margin:0 0 6px;color:${BRAND.ink};font-size:15px;font-weight:700;${FONT}">${esc(t('billing_bank_title'))}</p>`
      + `<p style="margin:0 0 8px;color:${BRAND.muted};font-size:13px;line-height:1.5;${FONT}">${esc(t('billing_bank_intro'))}</p>`
      + table(bank.map(([l, v], i) => row(l, v, { strong: i === 3, last: i === bank.length - 1 })).join('')) + '</div>';
    const html = '<!DOCTYPE html><html lang="mn"><head><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light">'
      + `<title>${esc(title)}</title></head>`
      + `<body style="margin:0;padding:0;background:${BRAND.paper}">`
      + `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(title)} · ${esc(totalAmount)}</div>`
      + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.paper}"><tr><td align="center" style="padding:24px 12px">`
      + `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#FFFFFF;border-radius:16px;overflow:hidden;border:1px solid ${BRAND.line}">`
      // header
      + `<tr><td style="background:${BRAND.navy};padding:18px 28px">`
      + `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>`
      + `<td style="padding-right:10px;vertical-align:middle"><img src="${esc(input.logoUrl)}" width="36" height="36" alt="" style="display:block;width:36px;height:36px;border-radius:8px;border:0"></td>`
      + `<td style="vertical-align:middle;color:#FFFFFF;font-size:19px;font-weight:800;letter-spacing:-0.01em;font-family:Manrope,Inter,'Segoe UI',Arial,sans-serif">DalaTech</td>`
      + `</tr></table></td></tr>`
      + (draft ? `<tr><td style="background:#FFE3E3;color:#8A1111;padding:8px 28px;font-size:13px;${FONT}">TEST — unsigned draft wording</td></tr>` : '')
      // body
      + `<tr><td style="padding:28px 28px 8px">`
      + `<h1 style="margin:0 0 16px;color:${BRAND.ink};font-size:22px;line-height:1.3;font-weight:800;font-family:Manrope,Inter,'Segoe UI',Arial,sans-serif">${esc(title)}</h1>`
      + paragraphs(intro, p)
      + `<div style="margin:8px 0 20px;padding:16px 18px;border:1px solid ${BRAND.line};border-radius:12px">`
      + `<p style="margin:0;color:${BRAND.muted};font-size:13px;${FONT}">${esc(totalLabel)}</p>`
      + `<p style="margin:2px 0 0;color:${BRAND.ink};font-size:30px;font-weight:800;font-family:Manrope,Inter,'Segoe UI',Arial,sans-serif">${esc(totalAmount)}</p>`
      + (receipt ? '' : `<p style="margin:4px 0 0;color:${BRAND.muted};font-size:13px;${FONT}">${esc(t('billing_page_due'))}: <strong style="color:${BRAND.ink}">${esc(dottedDay(inv.dueOn))}</strong></p>`)
      + `</div>`
      + payBlock
      + `<div style="margin:24px 0 0">${table(facts.map(([l, v], i) => row(l, v, { last: i === facts.length - 1 })).join(''))}</div>`
      + `<div style="margin:20px 0 0">${table(
        `<tr><td style="padding:0 0 6px;color:${BRAND.muted};font-size:12px;text-transform:uppercase;letter-spacing:0.06em;${FONT}">${esc(t('billing_label_service'))}</td>`
        + `<td align="right" style="padding:0 0 6px;color:${BRAND.muted};font-size:12px;text-transform:uppercase;letter-spacing:0.06em;${FONT}">${esc(t('billing_label_amount'))}</td></tr>`
        + lineRows + row(totalLabel, totalAmount, { strong: true, last: true }))}</div>`
      + (receipt ? `<p style="margin:16px 0 0;color:${BRAND.muted};font-size:13px;line-height:1.5;${FONT}">${esc(vat)}</p>` : '')
      + bankBlock
      + `<div style="margin:24px 0 0">${paragraphs(closing, p)}</div>`
      + `<p style="${p}">${esc(signoff)}<br><strong>${esc(issuer.name)}</strong><br>DalaTech</p>`
      + `</td></tr>`
      // footer
      + `<tr><td style="background:${BRAND.soft};padding:16px 28px;color:${BRAND.muted};font-size:12px;line-height:1.7;${FONT}">`
      + `<strong style="color:${BRAND.ink}">${esc(issuer.name)}</strong> · DalaTech<br>`
      + `${esc(t('billing_label_phone'))}: <a href="${esc(telHref(issuer.phone))}" style="color:${BRAND.muted};text-decoration:none">${esc(issuer.phone)}</a>`
      + ` · ${esc(t('billing_label_email'))}: <a href="mailto:${esc(issuer.email)}" style="color:${BRAND.muted};text-decoration:none">${esc(issuer.email)}</a><br>`
      + `${esc(t('billing_bank_name'))}: ${esc(issuer.bankAccount)} (${esc(issuer.bankHolder)})`
      + `</td></tr></table></td></tr></table></body></html>`;
    return { ok: true, text, html };
  } catch (err) {
    if (err instanceof Refused) return { ok: false, why: err.message };
    throw err;
  }
}
