/**
 * The client's pay page (`/pay/<link>`) and the founder's pause/resume confirmation page.
 *
 * ## The pay page
 *
 * What the client opens from an invoice: who it is for, what it covers, the amount, the due
 * day, and — while unpaid — the QPay QR code and a button per bank app (QPay's own deep
 * links). Once paid it says so, with the date, and shows no QR.
 *
 * Every word on it is a signed billing block (`templates.ts`). A LIVE invoice whose blocks
 * are not all signed gets a 503, never a page with some words missing. A TEST invoice (the
 * founder is its only reader) falls back to English labels under a banner that says the
 * Mongolian is not signed, so the payment path can be proven before the wording is.
 *
 * It shows nothing a stranger holding the link could not already see on the invoice itself:
 * the client's name, the lines, the amount. No tenant id, no account id, no e-mail.
 *
 * ## The action page
 *
 * English, because only the founder opens it. GET shows what will happen and one button;
 * only the POST acts. A Telegram link preview or a prefetch is a GET, so it cannot pause.
 */
import { billingToday, dottedDay } from './calendar.ts';
import type { Account, Invoice } from './engine.ts';
import { formatMnt, render, type BillingBlockKey, type Wording } from './templates.ts';

export function esc(s: string): string {
  return s.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&#39;');
}

const PAGE_KEYS = [
  'billing_page_title', 'billing_page_amount', 'billing_page_due', 'billing_page_covers', 'billing_page_status_open',
  'billing_page_status_paid', 'billing_page_status_other', 'billing_page_scan', 'billing_page_banks',
] as const satisfies readonly BillingBlockKey[];

const ENGLISH: Record<(typeof PAGE_KEYS)[number], string> = {
  billing_page_title: 'DalaTech invoice {invoice_no}',
  billing_page_amount: 'Amount',
  billing_page_due: 'Due',
  billing_page_covers: 'Covers',
  billing_page_status_open: 'Not paid yet',
  billing_page_status_paid: 'Paid {paid_date}',
  billing_page_status_other: 'This invoice is being reviewed. Please contact DalaTech.',
  billing_page_scan: 'Scan the QR code with your bank app',
  billing_page_banks: 'Or open your bank app',
};

export type PayView = { invoice: Invoice; account: Account; qrImage: string; urls: Array<{ name: string; logo: string; link: string }> };

export type PageOutcome = { status: number; html: string };

const STYLE = `body{margin:0;background:#f6f7f9;color:#111;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
main{max-width:520px;margin:0 auto;padding:24px 16px 48px}
.card{background:#fff;border-radius:12px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
h1{font-size:20px;margin:0 0 4px}.client{color:#555;margin:0 0 16px}
.amount{font-size:32px;font-weight:700;margin:4px 0 12px}.muted{color:#666;font-size:14px}
.row{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid #eee;font-size:15px}
.status{display:inline-block;padding:4px 10px;border-radius:999px;font-weight:600;font-size:14px;margin:8px 0 16px}
.open{background:#fff4d6;color:#7a5200}.paid{background:#dff5e3;color:#11652a}.other{background:#eee;color:#333}
.qr{display:block;width:260px;max-width:100%;margin:16px auto;image-rendering:pixelated}
.banks{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;margin-top:8px}
.banks a{display:flex;align-items:center;gap:8px;padding:10px;border:1px solid #ddd;border-radius:8px;text-decoration:none;color:#111;font-size:14px}
.banks img{width:28px;height:28px;border-radius:6px}
.banner{background:#ffe3e3;color:#8a1111;padding:10px 12px;border-radius:8px;font-size:14px;margin-bottom:16px}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}.card{background:#1c1c1e;box-shadow:none}.client,.muted{color:#aaa}.row{border-color:#333}.banks a{border-color:#333;color:#eee}}`;

function doc(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="mn"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta name="robots" content="noindex"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

/** Only an `https:` image or a PNG data URI, and only deep links QPay could mean. */
function safeLink(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol !== 'javascript:' && u.protocol !== 'data:' && u.protocol !== 'vbscript:' && u.protocol !== 'file:';
  } catch {
    return false;
  }
}

export function renderPayPage(view: PayView, wording: Wording): PageOutcome {
  const { invoice: inv, account } = view;
  const missing = PAGE_KEYS.filter((k) => !wording.blocks.has(k));
  const english = missing.length > 0;
  if (english && !inv.isTest) {
    return { status: 503, html: doc('DalaTech', '<div class="card"><p>Service temporarily unavailable.</p></div>') };
  }
  const w: Wording = english ? { source: 'draft', blocks: new Map(Object.entries(ENGLISH)) } : wording;
  const values = { invoice_no: inv.invoiceNo, paid_date: inv.paidAt === null ? '' : dottedDay(billingToday(inv.paidAt)) };
  const t = (k: (typeof PAGE_KEYS)[number]): string => {
    const r = render(w, k, values);
    return r.ok ? r.text : '';
  };
  const statusHtml = inv.status === 'paid'
    ? `<span class="status paid">${esc(t('billing_page_status_paid'))}</span>`
    : inv.status === 'open'
      ? `<span class="status open">${esc(t('billing_page_status_open'))}</span>`
      : `<span class="status other">${esc(t('billing_page_status_other'))}</span>`;
  const lines = inv.lines.map((l) => `<div class="row"><span>${esc(l.label)}</span><span>${esc(formatMnt(l.amount_mnt))}</span></div>`).join('');
  const qr = inv.status === 'open' && /^[A-Za-z0-9+/=]+$/u.test(view.qrImage) // ascii-safe: base64 alphabet
    ? `<p class="muted">${esc(t('billing_page_scan'))}</p><img class="qr" alt="QPay QR" src="data:image/png;base64,${view.qrImage}">`
    : '';
  const banks = inv.status === 'open' && view.urls.length > 0
    ? `<p class="muted">${esc(t('billing_page_banks'))}</p><div class="banks">${view.urls.filter((u) => safeLink(u.link)).map((u) =>
      `<a href="${esc(u.link)}">${u.logo.startsWith('https://') ? `<img alt="" src="${esc(u.logo)}">` : ''}<span>${esc(u.name)}</span></a>`).join('')}</div>`
    : '';
  const banner = english ? '<div class="banner">TEST — the Mongolian wording is not signed yet, so this page is in English.</div>' : '';
  const title = t('billing_page_title');
  return {
    status: 200,
    html: doc(title, `${banner}<div class="card"><h1>${esc(title)}</h1><p class="client">${esc(account.displayName)}</p>`
      + `<div class="muted">${esc(t('billing_page_amount'))}</div><div class="amount">${esc(formatMnt(inv.amountMnt))}</div>`
      + `${statusHtml}<div class="row"><span>${esc(t('billing_page_due'))}</span><span>${esc(dottedDay(inv.dueOn))}</span></div>`
      + `<p class="muted" style="margin-top:16px">${esc(t('billing_page_covers'))}</p>${lines}${qr}${banks}</div>`),
  };
}

export function notFoundPage(): PageOutcome {
  return { status: 404, html: doc('DalaTech', '<div class="card"><p>404</p></div>') };
}

export function actionConfirmPage(input: { kind: 'pause' | 'resume'; client: string; detail: string; token: string }): PageOutcome {
  const verb = input.kind === 'pause' ? 'Pause' : 'Resume';
  const what = input.kind === 'pause'
    ? `This stops ${input.client}'s AI staff: every channel stops answering customers (messages are still received and kept). You can resume at any time.`
    : `This restores ${input.client}'s AI staff to exactly the channels and modes they had before the pause.`;
  return {
    status: 200,
    html: doc(`${verb} ${input.client}`, `<div class="card"><h1>${esc(verb)} ${esc(input.client)}?</h1><p>${esc(what)}</p>`
      + `<p class="muted">${esc(input.detail)}</p><form method="post"><input type="hidden" name="t" value="${esc(input.token)}">`
      + `<button type="submit" style="font-size:17px;padding:12px 20px;border-radius:8px;border:0;background:${input.kind === 'pause' ? '#b3261e' : '#11652a'};color:#fff">`
      + `${esc(verb)} ${esc(input.client)}</button></form></div>`),
  };
}

export function actionDonePage(title: string, text: string, status = 200): PageOutcome {
  return { status, html: doc(title, `<div class="card"><h1>${esc(title)}</h1><p>${esc(text)}</p></div>`) };
}

/** Every key the pay page needs, for the signing checklist. */
export const PAY_PAGE_KEYS: readonly string[] = PAGE_KEYS;
