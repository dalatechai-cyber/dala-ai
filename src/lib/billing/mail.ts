/**
 * The client e-mail: invoice, the two reminders and the receipt, in the one e-mail design
 * every DalaTech product sends (2026-10-02, Ора's approved layout: `ora` repo,
 * `src/lib/server/mail-templates.ts`). The DalaTech wordmark above a white card; a navy
 * heading; the amount; one navy «Төлбөр төлөх» button with the raw address only as a small
 * fallback line; the invoice table and the Khan Bank alternative; and a footer saying who
 * sent it and why (DalaTech, dalatech.online, hello@dalatech.online). A hidden preheader is
 * the inbox preview line. A plain-text version carries the same content line by line; the
 * invoice and reminders attach the PDF (`pdf.ts`).
 *
 * Built for Gmail first (phone and desktop, light and dark), then Apple Mail and Outlook:
 * tables for layout, every style inline, system fonts, a PNG mark (many clients drop SVG),
 * a dark-mode stylesheet for the clients that honour it. TRANSACTIONAL: no unsubscribe link,
 * no marketing footer, no tracking pixel, no remote font.
 *
 * Every word is a signed block (`templates.ts`); the layout is the platform's. Values are
 * escaped for HTML. Three parts are OPTIONAL (`MAIL_OPTIONAL_KEYS`): the fallback line's
 * label and the footer's two sentences. While one is not signed it is left out (the raw link
 * still shows, the footer still names DalaTech), so adding them never stops an invoice.
 *
 * `mailReady` says whether the branded version can be sent at all (every required block
 * signed, the issuer's settings present). While it cannot, the engine sends the pre-0070
 * plain e-mail.
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

/** Parts of the e-mail that are left out while unsigned (never a reason to refuse). */
export const MAIL_OPTIONAL_KEYS = [
  'billing_mail_fallback_link', 'billing_mail_footer_why', 'billing_mail_footer_contact_label',
] as const satisfies readonly BillingBlockKey[];

/** Who sends every DalaTech e-mail, as Ора's footer names it. */
export const MAIL_SENDER = { name: 'DalaTech', site: 'dalatech.online', siteUrl: 'https://dalatech.online', contact: 'hello@dalatech.online' } as const;

/** The wordmark above the card: `public/brand/dalatech-wordmark.png`, 420×120, shown at 140×40. */
export const WORDMARK_PATH = '/brand/dalatech-wordmark.png';

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


// Ора's palette (DalaTech): navy for the heading and the button, ink on white, a muted grey
// at 5.9:1 on white for secondary text. Dark values for the clients that read the media query.
const C = {
  navy: '#131C45', ink: '#1B1F2A', muted: '#5B6273', line: '#E4E7EE', page: '#F2F4F8', link: '#0B6694', soft: '#F5F7FB',
} as const;
const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif`;
const DARK_CSS = `
  @media (max-width: 600px) { .card { padding: 28px 22px !important; } .outer { padding: 20px 12px !important; } }
  @media (prefers-color-scheme: dark) {
    .page { background: #0B0F1C !important; }
    .card { background: #151A2B !important; border-color: #2A3150 !important; }
    .box { background: #1B2238 !important; border-color: #2A3150 !important; }
    .h1, .txt { color: #EEF1F8 !important; }
    .muted { color: #A6ADBF !important; }
    .btn, .btn a { background: #60C8FF !important; color: #0B0F1C !important; }
    .lnk { color: #7FD3FF !important; }
    .rule { border-color: #2A3150 !important; }
  }`;

function para(text: string, size = 16, cls = 'txt', color: string = C.ink, margin = '0 0 16px 0'): string {
  return text.split(/\n{2,}/u).map((t) =>
    `<p class="${cls}" style="margin:${margin};font-family:${FONT};font-size:${size}px;line-height:1.6;color:${color};">${esc(t).replace(/\n/gu, '<br>')}</p>`).join('');
}

function row(label: string, value: string, opts: { strong?: boolean; last?: boolean } = {}): string {
  const border = opts.last === true ? '' : `border-bottom:1px solid ${C.line};`;
  return `<tr><td class="muted rule" style="padding:10px 0;${border}font-family:${FONT};font-size:14px;color:${C.muted};">${esc(label)}</td>`
    + `<td class="txt rule" align="right" style="padding:10px 0 10px 12px;${border}font-family:${FONT};font-size:14px;color:${C.ink};${opts.strong === true ? 'font-weight:700;' : ''}">${esc(value)}</td></tr>`;
}

function table(inner: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${inner}</table>`;
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
    // An optional part: left out while unsigned, refused like any block when it is signed
    // and broken.
    const opt = (key: (typeof MAIL_OPTIONAL_KEYS)[number]): string | null => (input.wording.blocks.has(key) ? t(key) : null);
    const title = t(TITLE[kind]);
    const intro = t(INTRO[kind]);
    const closing = t(receipt ? 'billing_mail_receipt_closing' : 'billing_mail_closing');
    const draft = input.wording.source === 'draft';
    const fallbackLabel = opt('billing_mail_fallback_link');
    const footerWhy = opt('billing_mail_footer_why');
    const contactLabel = opt('billing_mail_footer_contact_label');

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
    const dueLabel = t('billing_page_due');
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
    const phoneLabel = t('billing_label_phone');
    const emailLabel = t('billing_label_email');
    // The inbox line beside the subject: signed words and the figures only.
    const preheaderText = receipt
      ? `${title} · ${totalAmount}`
      : `${title} · ${totalAmount} · ${dueLabel}: ${dottedDay(inv.dueOn)}`;
    const footerLine = `${MAIL_SENDER.name} · ${MAIL_SENDER.site} · ${contactLabel === null ? '' : `${contactLabel} `}${MAIL_SENDER.contact}`;

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
        t('billing_bank_title'), t('billing_bank_intro'),
        ...bank.map(([l, v]) => `${l}: ${v}`), '',
      ]),
      closing, '',
      signoff, issuer.name, `${phoneLabel}: ${issuer.phone} · ${emailLabel}: ${issuer.email}`, '',
      '—',
      ...(footerWhy === null ? [] : [footerWhy]),
      footerLine,
    ].join('\n');

    // ---- HTML ----
    const small = `font-family:${FONT};font-size:13px;line-height:1.5;color:${C.muted};`;
    const lineRows = inv.lines.map((l) => row(l.label, formatMnt(l.amount_mnt))).join('');
    const payBlock = receipt ? '' :
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 16px 0;">`
      + `<tr><td class="btn" align="center" bgcolor="${C.navy}" style="border-radius:12px;background:${C.navy};">`
      + `<a href="${esc(input.payUrl)}" target="_blank" style="display:inline-block;padding:15px 28px;font-family:${FONT};font-size:16px;line-height:20px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:12px;">${esc(button)}</a>`
      + `</td></tr></table>`
      + (fallbackLabel === null ? '' : `<p class="muted" style="margin:0 0 4px 0;${small}">${esc(fallbackLabel)}</p>`)
      + `<p class="muted" style="margin:0 0 8px 0;${small}word-break:break-all;"><a class="lnk" href="${esc(input.payUrl)}" target="_blank" style="color:${C.link};text-decoration:underline;">${esc(input.payUrl)}</a></p>`;
    const bankBlock = receipt ? '' :
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0 0;"><tr>`
      + `<td class="box" style="padding:16px 18px;background:${C.soft};border:1px solid ${C.line};border-radius:12px;">`
      + `<p class="txt" style="margin:0 0 6px 0;font-family:${FONT};font-size:15px;font-weight:700;color:${C.ink};">${esc(t('billing_bank_title'))}</p>`
      + `<p class="muted" style="margin:0 0 8px 0;${small}">${esc(t('billing_bank_intro'))}</p>`
      + table(bank.map(([l, v], i) => row(l, v, { strong: i === 3, last: i === bank.length - 1 })).join(''))
      + `</td></tr></table>`;
    const amountBox =
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 20px 0;"><tr>`
      + `<td class="box" style="padding:16px 18px;background:${C.soft};border:1px solid ${C.line};border-radius:12px;">`
      + `<p class="muted" style="margin:0;${small}">${esc(totalLabel)}</p>`
      + `<p class="h1" style="margin:2px 0 0 0;font-family:${FONT};font-size:30px;line-height:1.2;font-weight:700;color:${C.navy};">${esc(totalAmount)}</p>`
      + (receipt ? '' : `<p class="muted" style="margin:4px 0 0 0;${small}">${esc(dueLabel)}: <strong class="txt" style="color:${C.ink};">${esc(dottedDay(inv.dueOn))}</strong></p>`)
      + `</td></tr></table>`;
    const serviceTable = table(
      `<tr><td class="muted" style="padding:0 0 6px 0;font-family:${FONT};font-size:12px;color:${C.muted};text-transform:uppercase;letter-spacing:0.06em;">${esc(t('billing_label_service'))}</td>`
      + `<td class="muted" align="right" style="padding:0 0 6px 0;font-family:${FONT};font-size:12px;color:${C.muted};text-transform:uppercase;letter-spacing:0.06em;">${esc(t('billing_label_amount'))}</td></tr>`
      + lineRows + row(totalLabel, totalAmount, { strong: true, last: true }));
    // The preheader is shown in the inbox list next to the subject; the filler stops the
    // client from appending the body's first words after it.
    const preheader = `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${C.page};opacity:0;">${esc(preheaderText)}${'&#847;&zwnj;&nbsp;'.repeat(40)}</div>`;
    const logo = input.logoUrl.startsWith('https://')
      ? `<img src="${esc(input.logoUrl)}" width="140" height="40" alt="DalaTech" style="display:block;width:140px;height:40px;border:0;outline:none;">`
      : `<span class="h1" style="font-family:${FONT};font-size:20px;font-weight:700;color:${C.navy};letter-spacing:-0.01em;">DalaTech</span>`;
    const footerLink = `color:${C.muted};text-decoration:underline;`;

    const html = `<!doctype html>
<html lang="mn" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(title)}</title>
<style>${DARK_CSS}
</style>
</head>
<body class="page" style="margin:0;padding:0;background:${C.page};-webkit-text-size-adjust:100%;">
${preheader}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="page" style="background:${C.page};">
  <tr><td class="outer" align="center" style="padding:32px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
      <tr><td style="padding:0 4px 18px 4px;">${logo}</td></tr>
      <tr><td class="card" style="background:#FFFFFF;border:1px solid ${C.line};border-radius:16px;padding:36px 36px 28px 36px;">
        ${draft ? `<p style="margin:0 0 18px 0;padding:8px 12px;background:#FFE3E3;color:#8A1111;border-radius:8px;font-family:${FONT};font-size:13px;">TEST — unsigned draft wording</p>` : ''}
        <h1 class="h1" style="margin:0 0 18px 0;font-family:${FONT};font-size:24px;line-height:1.3;font-weight:700;color:${C.navy};letter-spacing:-0.01em;">${esc(title)}</h1>
        ${para(intro)}
        ${amountBox}
        ${payBlock}
        <div style="margin:20px 0 0 0;">${table(facts.map(([l, v], i) => row(l, v, { last: i === facts.length - 1 })).join(''))}</div>
        <div style="margin:24px 0 0 0;">${serviceTable}</div>
        ${receipt ? para(vat, 13, 'muted', C.muted, '16px 0 0 0') : ''}
        ${bankBlock}
        <div style="margin:24px 0 0 0;">${para(closing)}</div>
        <p class="txt" style="margin:0 0 4px 0;font-family:${FONT};font-size:16px;line-height:1.6;color:${C.ink};">${esc(signoff)}<br><strong>${esc(issuer.name)}</strong></p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0 0 0;"><tr><td class="rule" style="border-top:1px solid ${C.line};padding-top:16px;">
          <p class="muted" style="margin:0;${small}">${esc(phoneLabel)}: <a class="lnk" href="${esc(telHref(issuer.phone))}" style="${footerLink}">${esc(issuer.phone)}</a> &nbsp;·&nbsp; ${esc(emailLabel)}: <a class="lnk" href="mailto:${esc(issuer.email)}" style="${footerLink}">${esc(issuer.email)}</a></p>
        </td></tr></table>
      </td></tr>
      <tr><td style="padding:22px 8px 0 8px;" align="center">
        ${footerWhy === null ? '' : `<p class="muted" style="margin:0 0 6px 0;font-family:${FONT};font-size:12px;line-height:1.6;color:${C.muted};">${esc(footerWhy)}</p>`}
        <p class="muted" style="margin:0;font-family:${FONT};font-size:12px;line-height:1.6;color:${C.muted};">
          <strong style="font-weight:600;">${MAIL_SENDER.name}</strong> &nbsp;|&nbsp;
          <a class="lnk" href="${MAIL_SENDER.siteUrl}" target="_blank" style="${footerLink}">${MAIL_SENDER.site}</a> &nbsp;|&nbsp;
          ${contactLabel === null ? '' : `${esc(contactLabel)} `}<a class="lnk" href="mailto:${MAIL_SENDER.contact}" style="${footerLink}">${MAIL_SENDER.contact}</a>
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
    return { ok: true, text, html };
  } catch (err) {
    if (err instanceof Refused) return { ok: false, why: err.message };
    throw err;
  }
}
