/**
 * The deposit page a customer opens from «Төлбөр төлөх» in Messenger: the QPay QR, one button
 * per bank app (on a phone, one tap opens the app with the payment filled in), and the
 * five-minute countdown, as Tara's website shows them. The QR and the held time end together, so
 * there is no «new QR» once it runs out: the page says the time has ended. «Шинэ QR код авах»
 * shows only when a hold still running has no usable QR (QPay refused the first).
 *
 * Under the tenant's own name, not DalaTech's: the customer is paying the salon. No web font,
 * no third-party request but QPay's own bank logos. Every word is a signed block; a page whose
 * words are not all signed is not shown (the flow cannot have started without them).
 */
import { esc } from '../billing/page.ts';
import { formatMnt } from '../billing/templates.ts';
import { say, WordingError, type BookingWording } from './wording.ts';

/**
 * `unavailable`: booking cannot run right now (switched off, not set up, or a read failed). The
 * route turns it into `unavailablePage`, with the branch's phone when it can be found.
 */
export type PageOutcome = { status: number; html: string; contentType?: 'json'; redirect?: true; unavailable?: true };

/** Booking cannot run: answered by the route with `unavailablePage`. */
export const UNAVAILABLE: PageOutcome = { status: 503, html: '', unavailable: true };

export type PageSummary = { tenantName: string; service: string; stylist: string; when: string; amountMnt: number; isTest: boolean };

export type PageView =
  | { kind: 'code'; summary: PageSummary; qrImage: string; urls: { name: string; logo: string; link: string }[]; secondsLeft: number }
  | { kind: 'renew'; summary: PageSummary }
  | { kind: 'wait'; summary: PageSummary }
  | { kind: 'paid'; summary: PageSummary }
  | { kind: 'ended'; summary: PageSummary };

const STYLE = `*{box-sizing:border-box}
body{margin:0;background:#F6F7F9;color:#111827;font-family:Inter,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
header{background:#111827;padding:14px 16px}
.brand{max-width:520px;margin:0 auto;color:#fff;font-weight:800;font-size:18px}
main{max-width:520px;margin:0 auto;padding:16px 16px 40px}
.card{background:#fff;border:1px solid #E5E7EB;border-radius:16px;padding:20px;margin-bottom:12px}
.eyebrow{margin:0;color:#6B7280;font-size:13px;font-weight:500}
.line{margin:6px 0 0;font-size:16px;line-height:1.4}
.label{margin:14px 0 0;color:#6B7280;font-size:13px}
.amount{margin:2px 0 0;font-size:34px;font-weight:800;font-variant-numeric:tabular-nums}
h2{margin:0 0 6px;font-size:17px;font-weight:800;text-align:center}
.muted{color:#6B7280;font-size:14px;line-height:1.5;margin:10px 0 6px}
.qr{display:block;width:240px;max-width:80%;margin:14px auto 6px;image-rendering:pixelated;border-radius:8px}
.countdown{text-align:center;font-weight:600;font-size:15px;margin:6px 0 16px;font-variant-numeric:tabular-nums;color:#1D4ED8}
.note{text-align:center;margin:12px 0 14px;font-size:15px;line-height:1.5}
.renew{display:block;width:100%;font:inherit;font-size:17px;font-weight:700;padding:15px;border-radius:12px;border:0;background:#1D4ED8;color:#fff;cursor:pointer}
.banks{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:8px}
.banks a{display:flex;align-items:center;gap:8px;padding:10px;border:1px solid #E5E7EB;border-radius:10px;text-decoration:none;color:#111827;font-size:14px;min-height:48px}
.banks img{width:28px;height:28px;border-radius:6px;flex:none}
.note a{color:#1D4ED8;font-weight:700;overflow-wrap:anywhere}
.note a[href^="tel:"]{white-space:nowrap}
.test{background:#FFF4D6;color:#7A5200;padding:10px 12px;border-radius:10px;font-size:14px;margin-bottom:12px;font-weight:600}`;

function doc(title: string, brand: string, body: string): string {
  return `<!DOCTYPE html><html lang="mn"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta name="robots" content="noindex"><meta name="color-scheme" content="light"><title>${esc(title)}</title><style>${STYLE}</style></head>`
    + `<body><header><div class="brand">${esc(brand)}</div></header><main>${body}</main></body></html>`;
}

/** A deep link QPay could mean: anything but script, data and file schemes. */
function safeLink(url: string): boolean {
  try {
    const u = new URL(url);
    // QPay's bank links are app schemes (khanbank://…) or https; nothing that runs or reads locally.
    return !['javascript:', 'data:', 'vbscript:', 'file:', 'blob:', 'about:', 'http:'].includes(u.protocol);
  } catch {
    return false;
  }
}

function jsString(s: string): string {
  return JSON.stringify(s).replace(/</gu, '\\u003c');
}

/** `4:59` from seconds. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * The countdown, and every 4 s the state (`?state=1`, which asks QPay): once the hold is no
 * longer waiting for payment the page reloads and shows what happened.
 */
function script(template: string | null, secondsLeft: number, ended = false): string {
  const tick = template === null ? '' : `var t=${jsString(template)},end=Date.now()+${Math.max(0, Math.floor(secondsLeft))}*1000;`
    + `var c=document.getElementById('qr-countdown'),live=document.getElementById('qr-live'),gone=document.getElementById('qr-expired');`
    + `function f(s){return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');}`
    + `function tick(){var s=Math.max(0,Math.floor((end-Date.now())/1000));if(c)c.textContent=t.replace('{time}',f(s));`
    // The QR and the held time end together: at zero the page reloads and says the time has ended.
    + `if(s<=0){clearInterval(i);if(live)live.style.display='none';if(gone)gone.style.display='block';setTimeout(function(){location.replace(location.pathname);},1500);}}`
    + `var i=setInterval(tick,1000);tick();`;
  // While waiting: reload once the hold is no longer waiting. On «ended»: keep asking for a
  // minute, and reload only if a payment turns up (QPay can be seconds behind the bank app).
  const done = ended ? `['paid','booked','paid_unbooked'].indexOf(d.state)>=0` : `d.state!=='held'`;
  return `<script>(function(){${tick}var n=0;`
    + `function poll(){if(document.hidden)return;if(${ended ? 'true' : 'false'}&&++n>15)return;fetch(location.pathname+'?state=1',{cache:'no-store'}).then(function(r){return r.ok?r.json():null;})`
    + `.then(function(d){if(d&&d.state&&${done})location.replace(location.pathname);}).catch(function(){});}`
    + `setInterval(poll,4000);})();</script>`;
}

export function renderBookingPage(view: PageView, w: BookingWording): PageOutcome {
  try {
    const s = view.summary;
    const title = say(w, 'booking_page_title');
    const head = `${s.isTest ? `<div class="test">${esc(say(w, 'booking_test_prefix'))}</div>` : ''}`
      + `<div class="card"><p class="eyebrow">${esc(title)}</p>`
      + `<p class="line">${esc(`${s.service}, ${s.stylist}`)}</p><p class="line">${esc(s.when)}</p>`
      + `<p class="label">${esc(say(w, 'billing_page_amount'))}</p><div class="amount">${esc(formatMnt(s.amountMnt))}</div></div>`;
    const renew = `<form method="post"><button class="renew" type="submit">${esc(say(w, 'billing_page_qr_renew'))}</button></form>`;
    let pay = '';
    let js = '';
    if (view.kind === 'code' && view.secondsLeft > 0 && /^[A-Za-z0-9+/=]+$/u.test(view.qrImage)) { // ascii-safe: base64 alphabet
      const banks = view.urls.filter((u) => safeLink(u.link));
      const valid = say(w, 'billing_page_qr_valid', { time: clock(view.secondsLeft) });
      pay = `<div id="qr-live"><h2>${esc(say(w, 'billing_page_scan'))}</h2>`
        + `<img class="qr" alt="QPay QR" src="data:image/png;base64,${view.qrImage}">`
        + `<p class="countdown" id="qr-countdown">${esc(valid)}</p>`
        + (banks.length > 0 ? `<p class="muted">${esc(say(w, 'billing_page_banks'))}</p><div class="banks">${banks.map((u) =>
          `<a href="${esc(u.link)}">${u.logo.startsWith('https://') ? `<img alt="" src="${esc(u.logo)}">` : ''}<span>${esc(u.name)}</span></a>`).join('')}</div>` : '')
        // No «new QR» here: the QR ends with the held time, and a new code cannot hold it longer.
        + `</div><div id="qr-expired" style="display:none"><p class="note">${esc(say(w, 'booking_page_ended'))}</p></div>`;
      js = script(say(w, 'billing_page_qr_valid', { time: '{time}' }), view.secondsLeft);
    } else if (view.kind === 'code' || view.kind === 'renew') {
      pay = `<div id="qr-expired"><p class="note">${esc(say(w, 'billing_page_qr_expired'))}</p>${renew}</div>`;
      js = script(null, 0);
    } else if (view.kind === 'wait') {
      pay = `<div><p class="note">${esc(say(w, 'billing_page_qr_wait'))}</p>${renew}</div>`;
      js = script(null, 0);
    } else if (view.kind === 'paid') {
      pay = `<p class="note">${esc(say(w, 'booking_page_paid'))}</p>`;
    } else {
      pay = `<p class="note">${esc(say(w, 'booking_page_ended'))}</p>`;
      js = script(null, 0, true);
    }
    return { status: 200, html: doc(title, s.tenantName, `${head}<div class="card">${pay}</div>${js}`) };
  } catch (e) {
    if (e instanceof WordingError) return UNAVAILABLE;
    throw e;
  }
}

/**
 * The page a customer sees when booking cannot run (in-chat booking switched off, a setting
 * missing, the database unreadable): no QR, no held time, nothing that looks broken, and how
 * to book instead. Its words cannot be read from `prompt_blocks`, because this page must also
 * answer when the database cannot be reached; so they live here.
 *
 * APPROVED by the founder on 2026-10-04, three cases, word for word
 * (prompt/drafts/booking/booking_page_unavailable.mn.txt). The title is the signed
 * `booking_page_title`, word for word.
 */
export const PAGE_UNAVAILABLE_TITLE = 'Урьдчилгаа төлбөр';
/** (a) The branch is known and its website booking is known to be working. */
export const PAGE_UNAVAILABLE_WEBSITE = 'Энэ холбоосоор одоогоор цаг захиалах боломжгүй байна. Цагаа эндээс захиална уу: {booking_url} Эсвэл {phone} дугаарт залгана уу.';
/** (b) The branch is known; its website booking is not, or not known to be, working. */
export const PAGE_UNAVAILABLE_PHONE = 'Онлайн захиалга одоогоор боломжгүй байна. Цаг захиалах бол {phone} дугаарт залгана уу.';
/** (c) The branch is not known. */
export const PAGE_UNAVAILABLE_NO_PHONE = 'Онлайн захиалга одоогоор боломжгүй байна. Цаг захиалах бол Messenger-ээр бичнэ үү.';

/**
 * Who the link belongs to, when that could be found: the branch's name, its phone numbers, its
 * own booking link (`tenant_booking.booking_url`) and whether that website booking is KNOWN to
 * be working. Never «probably»: a customer is not sent to a website booking that is switched off.
 */
export type PageContact = { tenantName: string | null; phones: string[]; bookingUrl: string | null; websiteBookingWorking: boolean };

/** Fill `{name}` slots: text escaped, the given HTML (links) as is. */
function fill(template: string, html: Record<string, string>): string {
  return template.split(/(\{[a-z_]+\})/u).map((part) => {
    const m = /^\{([a-z_]+)\}$/u.exec(part);
    return m !== null && m[1] !== undefined && m[1] in html ? html[m[1]] as string : esc(part);
  }).join('');
}

/** Which of the three lines, and its HTML, for this contact. */
export function unavailableLine(contact: PageContact): { kind: 'website' | 'phone' | 'none'; html: string } {
  const phones = contact.phones.filter((p) => /^\d{8}$/u.test(p));
  if (phones.length === 0) return { kind: 'none', html: esc(PAGE_UNAVAILABLE_NO_PHONE) };
  const phone = phones.map((p) => `<a href="tel:+976${p}">${p}</a>`).join(', ');
  const url = contact.bookingUrl;
  if (contact.websiteBookingWorking && url !== null && /^https:\/\/[^\s"<>]+$/u.test(url)) {
    return { kind: 'website', html: fill(PAGE_UNAVAILABLE_WEBSITE, { booking_url: `<a href="${esc(url)}">${esc(url)}</a>`, phone }) };
  }
  return { kind: 'phone', html: fill(PAGE_UNAVAILABLE_PHONE, { phone }) };
}

/** 503 with the calm page (the poll gets JSON); numbers are tap-to-call, the link opens. */
export function unavailablePage(contact: PageContact, stateOnly = false): PageOutcome {
  if (stateOnly) return { status: 503, contentType: 'json', html: '{"state":"unavailable"}' };
  const { html } = unavailableLine(contact);
  return {
    status: 503,
    html: doc(PAGE_UNAVAILABLE_TITLE, contact.tenantName ?? '', `<div class="card"><p class="eyebrow">${esc(PAGE_UNAVAILABLE_TITLE)}</p><p class="note">${html}</p></div>`),
  };
}

export function notFoundPage(): PageOutcome {
  return { status: 404, html: doc('404', '—', '<div class="card"><p>Not found.</p></div>') };
}
