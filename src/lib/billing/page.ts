/**
 * The client's pay page (`/pay/<ref>`, and `pay.dalatech.online/<ref>`) and the founder's
 * pause/resume confirmation page.
 *
 * ## The pay page
 *
 * What the client opens from an invoice, in DalaTech's own look (0070: the mark, the navy and
 * blue of dalatech.online, Inter and Manrope), built for a phone first: who it is for, the
 * amount and its status, the due day, what it covers, and — while unpaid — a QPay QR code
 * made for this visit, with a countdown to its end (QPay codes live five minutes), and a
 * button per bank app (QPay's own deep links). At zero the QR gives way to «Шинэ QR код
 * авах», which makes a new one (0068). Below it, the Khan Bank transfer for a client who
 * would rather not use QPay, and the founder's phone for a question. Once paid it says so,
 * with the date, and shows no QR and no bank details.
 *
 * Every word on it is a signed billing block (`templates.ts`). A LIVE invoice whose core
 * blocks are not all signed gets a 503, never a page with some words missing; the 0070
 * sections (bank transfer, phone) are shown to a live client only once theirs are signed
 * and the issuer's settings are set, and are simply absent until then. A TEST invoice (the
 * founder is its only reader) falls back to English under a banner that says so, so the
 * payment path can be proven before the wording is.
 *
 * It shows nothing a stranger holding the link could not already see on the invoice itself:
 * the client's name, the lines, the amount, and DalaTech's own contact and bank details. No
 * tenant id, no account id, no client e-mail.
 *
 * ## The action page
 *
 * English, because only the founder opens it. GET shows what will happen and one button;
 * only the POST acts. A Telegram link preview or a prefetch is a GET, so it cannot pause.
 */
import { billingToday, dottedDay } from './calendar.ts';
import type { Account, Invoice } from './engine.ts';
import { telHref, type Issuer } from './issuer.ts';
import { BRAND } from './mail.ts';
import { formatMnt, render, type BillingBlockKey, type Wording } from './templates.ts';

export function esc(s: string): string {
  return s.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&#39;');
}

const PAGE_KEYS = [
  'billing_page_title', 'billing_page_amount', 'billing_page_due', 'billing_page_covers', 'billing_page_status_open',
  'billing_page_status_paid', 'billing_page_status_other', 'billing_page_scan', 'billing_page_banks',
  'billing_page_qr_valid', 'billing_page_qr_expired', 'billing_page_qr_renew', 'billing_page_qr_wait',
] as const satisfies readonly BillingBlockKey[];

/** 0070: the bank transfer and the phone. Optional for a live page: absent until signed. */
const EXTRA_KEYS = [
  'billing_bank_title', 'billing_bank_intro', 'billing_bank_name', 'billing_label_bank', 'billing_label_account',
  'billing_label_holder', 'billing_label_reference', 'billing_label_amount', 'billing_page_questions',
] as const satisfies readonly BillingBlockKey[];

/** The lines of a page that shows (or offers) a QPay code: a live invoice needs them signed. */
export const PAY_CODE_KEYS: readonly string[] = ['billing_page_qr_valid', 'billing_page_qr_expired', 'billing_page_qr_renew', 'billing_page_qr_wait'];
const CODE_KEYS: ReadonlySet<string> = new Set(PAY_CODE_KEYS);

type PageKey = (typeof PAGE_KEYS)[number] | (typeof EXTRA_KEYS)[number];

const ENGLISH: Record<PageKey, string> = {
  billing_page_title: 'DalaTech invoice {invoice_no}',
  billing_page_amount: 'Amount',
  billing_page_due: 'Due',
  billing_page_covers: 'Covers',
  billing_page_status_open: 'Not paid yet',
  billing_page_status_paid: 'Paid {paid_date}',
  billing_page_status_other: 'This invoice is being reviewed. Please contact DalaTech.',
  billing_page_scan: 'Scan the QR code with your bank app',
  billing_page_banks: 'Or open your bank app',
  billing_page_qr_valid: 'QR code valid for {time}',
  billing_page_qr_expired: 'The QR code has expired. Press the button below for a new QR code.',
  billing_page_qr_renew: 'Get a new QR code',
  billing_page_qr_wait: 'You have asked for many QR codes. Please wait a while, then press the button below again.',
  billing_bank_title: 'Pay by bank transfer',
  billing_bank_intro: 'If you would rather not use QPay, transfer to the account below. Put the invoice number in the reference.',
  billing_bank_name: 'Khan Bank',
  billing_label_bank: 'Bank',
  billing_label_account: 'Account number',
  billing_label_holder: 'Account holder',
  billing_label_reference: 'Reference',
  billing_label_amount: 'Amount',
  billing_page_questions: 'Questions? Call {phone}.',
};

type PageExtras = {
  /** The founder's phone and bank account (0070), or null while not configured. */
  issuer?: Issuer | null;
  /** The mark, absolute URL, or null. */
  logoUrl?: string | null;
};

/**
 * What the page shows (0068): a live QPay code with its countdown, no code (the hourly cap;
 * the button is offered again), or a settled invoice (paid, or with the founder).
 */
export type PayView = PageExtras & (
  | { kind: 'code'; invoice: Invoice; account: Account; qrImage: string; urls: Array<{ name: string; logo: string; link: string }>; secondsLeft: number }
  | { kind: 'no_code'; invoice: Invoice; account: Account }
  | { kind: 'settled'; invoice: Invoice; account: Account });

export type PageOutcome = { status: number; html: string; contentType?: 'json'; redirect?: true };

// No web font: loading one would send every client's address to a third party. Inter and
// Manrope are used where the device has them; the system font otherwise.
const STYLE = `*{box-sizing:border-box}
body{margin:0;background:${BRAND.paper};color:${BRAND.ink};font-family:Inter,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
header{background:${BRAND.navy};padding:14px 16px}
.brand{max-width:520px;margin:0 auto;display:flex;align-items:center;gap:10px;color:#fff;font-family:Manrope,Inter,sans-serif;font-weight:800;font-size:19px;letter-spacing:-.01em}
.brand img{width:32px;height:32px;border-radius:8px;display:block}
main{max-width:520px;margin:0 auto;padding:16px 16px 40px}
.card{background:#fff;border:1px solid ${BRAND.line};border-radius:16px;padding:20px;margin-bottom:12px}
.eyebrow{margin:0;color:${BRAND.muted};font-size:13px;font-weight:500}
.client{margin:4px 0 14px;font-family:Manrope,Inter,sans-serif;font-weight:800;font-size:21px;line-height:1.25}
.label{margin:0;color:${BRAND.muted};font-size:13px}
.amount{margin:2px 0 10px;font-family:Manrope,Inter,sans-serif;font-size:34px;font-weight:800;letter-spacing:-.01em;font-variant-numeric:tabular-nums}
.status{display:inline-block;padding:5px 12px;border-radius:999px;font-weight:600;font-size:13px}
.open{background:#FFF4D6;color:#7A5200}.paid{background:#DFF5E3;color:#11652A}.other{background:#EEF1F6;color:#334155}
.row{display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:11px 0;border-bottom:1px solid ${BRAND.line};font-size:15px}
.row:last-child{border-bottom:0}.row span:first-child{color:${BRAND.muted}}.row span:last-child{text-align:right;font-weight:500}
.row.total span{color:${BRAND.ink};font-weight:700}
h2{margin:0 0 6px;font-family:Manrope,Inter,sans-serif;font-size:17px;font-weight:800}
.muted{color:${BRAND.muted};font-size:14px;line-height:1.5;margin:0 0 10px}
.qr{display:block;width:240px;max-width:80%;margin:14px auto 6px;image-rendering:pixelated;border-radius:8px}
.countdown{text-align:center;font-weight:600;font-size:15px;margin:6px 0 16px;font-variant-numeric:tabular-nums;color:${BRAND.blue}}
.expired{text-align:center;margin:12px 0 14px;font-size:15px;line-height:1.5}
.renew{display:block;width:100%;font:inherit;font-size:17px;font-weight:700;padding:15px;border-radius:12px;border:0;background:${BRAND.blue};color:#fff;cursor:pointer}
.banks{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:8px}
.banks a{display:flex;align-items:center;gap:8px;padding:10px;border:1px solid ${BRAND.line};border-radius:10px;text-decoration:none;color:${BRAND.ink};font-size:14px;min-height:48px}
.banks img{width:28px;height:28px;border-radius:6px;flex:none}
.ref{font-weight:700;color:${BRAND.ink}}
.help{text-align:center;color:${BRAND.muted};font-size:14px;margin:18px 0 0;line-height:1.6}
.help a{color:${BRAND.blue};font-weight:600;text-decoration:none}
.banner{background:#FFE3E3;color:#8A1111;padding:10px 12px;border-radius:10px;font-size:14px;margin-bottom:12px}
footer{text-align:center;color:${BRAND.muted};font-size:12px;padding:0 16px 28px}`;

function doc(title: string, body: string, logoUrl?: string | null): string {
  const mark = logoUrl !== undefined && logoUrl !== null && logoUrl.startsWith('https://') ? `<img alt="" src="${esc(logoUrl)}">` : '';
  return `<!DOCTYPE html><html lang="mn"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta name="robots" content="noindex"><meta name="color-scheme" content="light"><meta name="theme-color" content="${BRAND.navy}">`
    + `<title>${esc(title)}</title><style>${STYLE}</style></head>`
    + `<body><header><div class="brand">${mark}<span>DalaTech</span></div></header><main>${body}</main></body></html>`;
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

/** `4:59` from seconds: what the countdown line shows (Tara's format). */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** A string safe inside an inline <script>: JSON, with `<` escaped so `</script>` cannot close it. */
function jsString(s: string): string {
  return JSON.stringify(s).replace(/</gu, '\\u003c');
}

/**
 * The countdown, and what happens at zero: the QR and the bank buttons are replaced by the
 * expired line and the «Шинэ QR код авах» button (a POST to this same page, which makes a
 * new code). Meanwhile the page asks every 5 s whether the invoice is still open (the
 * database only, not QPay: the QPay callback records the payment) and reloads once it is
 * not, so a client who has just paid sees «paid», not a countdown.
 */
function script(template: string, secondsLeft: number): string {
  return `<script>(function(){var t=${jsString(template)},end=Date.now()+${Math.max(0, Math.floor(secondsLeft))}*1000;`
    + `var c=document.getElementById('qr-countdown'),live=document.getElementById('qr-live'),gone=document.getElementById('qr-expired');`
    + `function f(s){return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');}`
    + `function tick(){var s=Math.max(0,Math.floor((end-Date.now())/1000));if(c)c.textContent=t.replace('{time}',f(s));`
    + `if(s<=0){clearInterval(i);if(live)live.style.display='none';if(gone)gone.style.display='block';}}`
    + `var i=setInterval(tick,1000);tick();`
    + `function poll(){if(document.hidden)return;fetch(location.pathname+'?state=1',{cache:'no-store'}).then(function(r){return r.ok?r.json():null;})`
    + `.then(function(d){if(d&&d.status&&d.status!=='open')location.replace(location.pathname);}).catch(function(){});}`
    + `setInterval(poll,5000);})();</script>`;
}

export function renderPayPage(view: PayView, wording: Wording): PageOutcome {
  const { invoice: inv, account } = view;
  // A paid (or reviewed) invoice shows no code: the code lines are not needed to show it.
  const needed = view.kind === 'settled' ? PAGE_KEYS.filter((k) => !CODE_KEYS.has(k)) : PAGE_KEYS;
  const missing = new Set(needed.filter((k) => !wording.blocks.has(k)));
  // A live client only ever reads signed words. The founder's test invoice shows the signed
  // ones and English for the rest, under a banner saying so.
  if (missing.size > 0 && !inv.isTest) {
    return { status: 503, html: doc('DalaTech', '<div class="card"><p>Service temporarily unavailable.</p></div>', view.logoUrl) };
  }
  // The bank transfer and the phone: for a live client only once signed and configured; on
  // a paid page neither is shown (nothing is left to pay, and no one needs to ask).
  const issuer = view.issuer ?? null;
  const extrasSigned = EXTRA_KEYS.every((k) => wording.blocks.has(k));
  const extrasWanted = issuer !== null && inv.status === 'open' && view.kind !== 'settled';
  const showExtras = extrasWanted && (extrasSigned || inv.isTest);
  const english = missing.size > 0 || (showExtras && !extrasSigned);
  const all: readonly PageKey[] = [...PAGE_KEYS, ...EXTRA_KEYS];
  const w: Wording = !english ? wording : {
    source: 'draft',
    blocks: new Map(all.map((k) => [k, wording.blocks.get(k) ?? ENGLISH[k]])),
  };
  const values = {
    invoice_no: inv.invoiceNo,
    paid_date: inv.paidAt === null ? '' : dottedDay(billingToday(inv.paidAt)),
    time: view.kind === 'code' ? clock(view.secondsLeft) : '0:00',
    phone: issuer?.phone ?? '',
  };
  const t = (k: PageKey, v: Record<string, string> = values): string => {
    const r = render(w, k, v);
    return r.ok ? r.text : '';
  };
  const statusHtml = inv.status === 'paid'
    ? `<span class="status paid">${esc(t('billing_page_status_paid'))}</span>`
    : inv.status === 'open'
      ? `<span class="status open">${esc(t('billing_page_status_open'))}</span>`
      : `<span class="status other">${esc(t('billing_page_status_other'))}</span>`;
  const lines = inv.lines.map((l) => `<div class="row"><span>${esc(l.label)}</span><span>${esc(formatMnt(l.amount_mnt))}</span></div>`).join('');
  let pay = '';
  if (inv.status === 'open' && view.kind !== 'settled') {
    const renew = `<form method="post"><button class="renew" type="submit">${esc(t('billing_page_qr_renew'))}</button></form>`;
    const expired = `<p class="expired">${esc(t('billing_page_qr_expired'))}</p>${renew}`;
    if (view.kind === 'code' && view.secondsLeft > 0 && /^[A-Za-z0-9+/=]+$/u.test(view.qrImage)) { // ascii-safe: base64 alphabet
      const banks = view.urls.filter((u) => safeLink(u.link));
      pay = `<div id="qr-live"><h2>${esc(t('billing_page_scan'))}</h2>`
        + `<img class="qr" alt="QPay QR" src="data:image/png;base64,${view.qrImage}">`
        + `<p class="countdown" id="qr-countdown">${esc(t('billing_page_qr_valid'))}</p>`
        + (banks.length > 0 ? `<p class="muted">${esc(t('billing_page_banks'))}</p><div class="banks">${banks.map((u) =>
          `<a href="${esc(u.link)}">${u.logo.startsWith('https://') ? `<img alt="" src="${esc(u.logo)}">` : ''}<span>${esc(u.name)}</span></a>`).join('')}</div>` : '')
        + `</div><div id="qr-expired" style="display:none">${expired}</div>`
        + script(t('billing_page_qr_valid', { ...values, time: '{time}' }), view.secondsLeft);
    } else if (view.kind === 'no_code') {
      pay = `<div id="qr-expired"><p class="expired">${esc(t('billing_page_qr_wait'))}</p>${renew}</div>`;
    } else {
      pay = `<div id="qr-expired">${expired}</div>`;
    }
    pay = `<div class="card">${pay}</div>`;
    if (showExtras && issuer !== null) {
      pay += `<div class="card"><h2>${esc(t('billing_bank_title'))}</h2><p class="muted">${esc(t('billing_bank_intro'))}</p>`
        + `<div class="row"><span>${esc(t('billing_label_bank'))}</span><span>${esc(t('billing_bank_name'))}</span></div>`
        + `<div class="row"><span>${esc(t('billing_label_account'))}</span><span class="ref">${esc(issuer.bankAccount)}</span></div>`
        + `<div class="row"><span>${esc(t('billing_label_holder'))}</span><span>${esc(issuer.bankHolder)}</span></div>`
        + `<div class="row"><span>${esc(t('billing_label_reference'))}</span><span class="ref">${esc(inv.invoiceNo)}</span></div>`
        + `<div class="row"><span>${esc(t('billing_label_amount'))}</span><span class="ref">${esc(formatMnt(inv.amountMnt))}</span></div></div>`;
    }
  }
  const help = showExtras && issuer !== null
    ? `<p class="help">${esc(t('billing_page_questions')).replace(esc(issuer.phone), `<a href="${esc(telHref(issuer.phone))}">${esc(issuer.phone)}</a>`)}</p>`
    : '';
  const banner = english ? '<div class="banner">TEST — some of this page\'s Mongolian is not signed yet, so those parts are in English.</div>' : '';
  const title = t('billing_page_title');
  return {
    status: 200,
    html: doc(title, `${banner}<div class="card"><p class="eyebrow">${esc(title)}</p><p class="client">${esc(account.displayName)}</p>`
      + `<p class="label">${esc(t('billing_page_amount'))}</p><div class="amount">${esc(formatMnt(inv.amountMnt))}</div>`
      + `${statusHtml}<div style="margin-top:14px"><div class="row"><span>${esc(t('billing_page_due'))}</span><span>${esc(dottedDay(inv.dueOn))}</span></div></div>`
      + `<h2 style="margin-top:18px">${esc(t('billing_page_covers'))}</h2>${lines}</div>${pay}${help}`
      + (issuer !== null ? `<footer>${esc(issuer.name)} · DalaTech</footer>` : ''), view.logoUrl),
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
    html: doc(`${verb} ${input.client}`, `<div class="card"><h2>${esc(verb)} ${esc(input.client)}?</h2><p>${esc(what)}</p>`
      + `<p class="muted">${esc(input.detail)}</p><form method="post"><input type="hidden" name="t" value="${esc(input.token)}">`
      + `<button type="submit" style="font-size:17px;padding:12px 20px;border-radius:8px;border:0;background:${input.kind === 'pause' ? '#b3261e' : '#11652a'};color:#fff">`
      + `${esc(verb)} ${esc(input.client)}</button></form></div>`),
  };
}

export function actionDonePage(title: string, text: string, status = 200): PageOutcome {
  return { status, html: doc(title, `<div class="card"><h2>${esc(title)}</h2><p>${esc(text)}</p></div>`) };
}

/** Every key the pay page needs, for the signing checklist. */
export const PAY_PAGE_KEYS: readonly string[] = [...PAGE_KEYS, ...EXTRA_KEYS];
