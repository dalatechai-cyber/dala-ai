/**
 * The formal PDF invoice (нэхэмжлэх) attached to the invoice e-mail and its reminders (0070).
 *
 * One A4 page with what a Mongolian bookkeeper looks for: НЭХЭМЖЛЭХ and its number, the
 * issuer (Нэхэмжлэгч: DalaTech, the founder's name, phone, e-mail, the Khan Bank account)
 * and the payer (Төлөгч, the contract number), the dates, the service lines and the total,
 * how to pay (the short QPay address, and a bank transfer with the invoice number as the
 * reference), the VAT sentence, and a line for the signature.
 *
 * Every word is a signed block, the same ones the e-mail uses (`mail.ts`); the fonts are
 * dalatech.online's own (Inter, Manrope), embedded and subset, so Cyrillic and ₮ print the
 * same on every machine. A line too long for its column wraps; a page is never overfilled
 * silently: an invoice whose lines do not fit refuses and the founder is told.
 */
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, PDFString, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { INTER_BOLD, INTER_REGULAR, LOGO_MARK_JPG, MANROPE_EXTRABOLD } from './assets/brand.ts';
import { dottedDay } from './calendar.ts';
import type { Account, Invoice } from './engine.ts';
import type { Issuer } from './issuer.ts';
import { BRAND, DOC_KEYS, shownAddress } from './mail.ts';
import { formatMnt, render, type BillingBlockKey, type Wording } from './templates.ts';

export type PdfInput = {
  wording: Wording;
  invoice: Invoice;
  account: Pick<Account, 'displayName'> & { contractRef: string | null };
  issuer: Issuer;
  payUrl: string;
};

export type RenderedPdf = { ok: true; base64: string; name: string } | { ok: false; why: string };

const A4 = { w: 595.28, h: 841.89 } as const;
const M = 48; // margin

function hex(c: string) {
  const n = Number.parseInt(c.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/** Words of `text` in lines no wider than `width`. A single word wider than that is cut. */
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let cur = '';
    for (const word of para.split(/\s+/u).filter((w) => w !== '')) {
      const next = cur === '' ? word : `${cur} ${word}`;
      if (font.widthOfTextAtSize(next, size) <= width) { cur = next; continue; }
      if (cur !== '') out.push(cur);
      let rest = word;
      while (font.widthOfTextAtSize(rest, size) > width) {
        let n = [...rest].length;
        while (n > 1 && font.widthOfTextAtSize([...rest].slice(0, n).join(''), size) > width) n -= 1;
        out.push([...rest].slice(0, n).join(''));
        rest = [...rest].slice(n).join('');
      }
      cur = rest;
    }
    out.push(cur);
  }
  return out;
}

function link(page: PDFPage, doc: PDFDocument, rect: [number, number, number, number], url: string): void {
  const annot = doc.context.register(doc.context.obj({
    Type: 'Annot', Subtype: 'Link', Rect: rect, Border: [0, 0, 0],
    A: { Type: 'Action', S: 'URI', URI: PDFString.of(url) },
  }));
  page.node.addAnnot(annot);
}

class Refused extends Error {}

/**
 * Base64 to bytes in an array of their OWN. A small `Buffer.from` is a slice of Node's shared
 * pool (byteOffset ≠ 0), and pdf-lib reads the underlying ArrayBuffer from its start: the
 * JPEG then has no start-of-image marker ("SOI not found"), depending on what ran before.
 */
function bytesOf(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

export async function renderInvoicePdf(input: PdfInput): Promise<RenderedPdf> {
  const { invoice: inv, account, issuer } = input;
  const t = (key: BillingBlockKey): string => {
    const r = render(input.wording, key, { invoice_no: inv.invoiceNo });
    if (!r.ok) throw new Refused(r.why);
    return r.text;
  };
  try {
    for (const k of DOC_KEYS) t(k);
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const regular = await doc.embedFont(bytesOf(INTER_REGULAR), { subset: true });
    const bold = await doc.embedFont(bytesOf(INTER_BOLD), { subset: true });
    const display = await doc.embedFont(bytesOf(MANROPE_EXTRABOLD), { subset: true });
    const mark = await doc.embedJpg(bytesOf(LOGO_MARK_JPG));
    const title = `${t('billing_doc_title')} № ${inv.invoiceNo}`;
    doc.setTitle(title);
    doc.setAuthor(`DalaTech — ${issuer.name}`);
    doc.setCreator('DalaTech');
    doc.setProducer('DalaTech');
    doc.setLanguage('mn');
    doc.setCreationDate(inv.createdAt);
    doc.setModificationDate(inv.createdAt);

    const page = doc.addPage([A4.w, A4.h]);
    const ink = hex(BRAND.ink);
    const muted = hex(BRAND.muted);
    const line = hex(BRAND.line);
    const text = (s: string, x: number, y: number, o: { font?: PDFFont; size?: number; color?: ReturnType<typeof rgb> } = {}) =>
      page.drawText(s, { x, y, font: o.font ?? regular, size: o.size ?? 10, color: o.color ?? ink });
    const right = (s: string, xr: number, y: number, o: { font?: PDFFont; size?: number; color?: ReturnType<typeof rgb> } = {}) =>
      text(s, xr - (o.font ?? regular).widthOfTextAtSize(s, o.size ?? 10), y, o);

    // Header band
    page.drawRectangle({ x: 0, y: A4.h - 92, width: A4.w, height: 92, color: hex(BRAND.navy) });
    page.drawImage(mark, { x: M, y: A4.h - 70, width: 44, height: 44 });
    text('DalaTech', M + 54, A4.h - 56, { font: display, size: 22, color: rgb(1, 1, 1) });
    right(t('billing_doc_title'), A4.w - M, A4.h - 48, { font: display, size: 20, color: rgb(1, 1, 1) });
    right(`№ ${inv.invoiceNo}`, A4.w - M, A4.h - 68, { font: bold, size: 11, color: hex(BRAND.sky) });

    // Parties
    let y = A4.h - 130;
    const colW = (A4.w - 2 * M - 24) / 2;
    const party = (x: number, heading: string, rows: Array<[string | null, string]>) => {
      text(heading.toUpperCase(), x, y, { font: bold, size: 8.5, color: muted });
      let yy = y - 18;
      for (const [label, value] of rows) {
        const shown = label === null ? value : `${label}: ${value}`;
        for (const l of wrap(shown, label === null ? bold : regular, label === null ? 11 : 9.5, colW)) {
          text(l, x, yy, { font: label === null ? bold : regular, size: label === null ? 11 : 9.5 });
          yy -= label === null ? 15 : 13.5;
        }
      }
      return yy;
    };
    const yl = party(M, t('billing_label_issuer'), [
      [null, 'DalaTech'], [null, issuer.name],
      [t('billing_label_phone'), issuer.phone], [t('billing_label_email'), issuer.email],
      [t('billing_label_bank'), t('billing_bank_name')], [t('billing_label_account'), issuer.bankAccount],
      [t('billing_label_holder'), issuer.bankHolder],
    ]);
    const yr = party(M + colW + 24, t('billing_label_payer'), [
      [null, account.displayName],
      ...(account.contractRef === null ? [] : [[t('billing_label_contract_no'), account.contractRef] as [string, string]]),
      [t('billing_label_invoice_no'), inv.invoiceNo],
      [t('billing_label_issued_on'), dottedDay(inv.issuedOn)],
      [t('billing_page_due'), dottedDay(inv.dueOn)],
    ]);
    y = Math.min(yl, yr) - 14;

    // Lines
    const x0 = M;
    const x1 = A4.w - M;
    const numW = 28;
    const amtW = 110;
    const descW = x1 - x0 - numW - amtW - 16;
    page.drawRectangle({ x: x0, y: y - 8, width: x1 - x0, height: 26, color: hex(BRAND.soft) });
    text('№', x0 + 8, y, { font: bold, size: 9, color: muted });
    text(t('billing_label_service'), x0 + numW + 8, y, { font: bold, size: 9, color: muted });
    right(t('billing_label_amount'), x1 - 8, y, { font: bold, size: 9, color: muted });
    y -= 30;
    let n = 0;
    for (const l of inv.lines) {
      n += 1;
      const parts = wrap(l.label, regular, 10, descW);
      if (y - parts.length * 14 < 230) throw new Refused(`the invoice has too many lines for one PDF page (${inv.lines.length})`);
      text(String(n), x0 + 8, y, { size: 10, color: muted });
      parts.forEach((p, i) => text(p, x0 + numW + 8, y - i * 14, { size: 10 }));
      right(formatMnt(l.amount_mnt), x1 - 8, y, { size: 10 });
      y -= parts.length * 14 + 8;
      // Between this row's descenders and the next row's capitals.
      page.drawLine({ start: { x: x0, y: y + 13 }, end: { x: x1, y: y + 13 }, thickness: 0.6, color: line });
    }
    y -= 10;
    text(t('billing_label_total'), x0 + numW + 8, y, { font: bold, size: 12 });
    right(formatMnt(inv.amountMnt), x1 - 8, y, { font: display, size: 16 });
    y -= 36;

    // How to pay
    page.drawRectangle({ x: x0, y: y - 74, width: x1 - x0, height: 94, color: hex(BRAND.soft) });
    const payLabel = `${t('billing_pay_button')}:`;
    text(payLabel, x0 + 14, y - 8, { font: bold, size: 10.5 });
    const shown = shownAddress(input.payUrl);
    const px = x0 + 14 + bold.widthOfTextAtSize(payLabel, 10.5) + 6;
    text(shown, px, y - 8, { font: bold, size: 10.5, color: hex(BRAND.blue) });
    link(page, doc, [px, y - 11, px + bold.widthOfTextAtSize(shown, 10.5), y + 3], input.payUrl);
    let by = y - 28;
    text(t('billing_bank_title'), x0 + 14, by, { font: bold, size: 10.5 });
    by -= 15;
    const bankLine = `${t('billing_bank_name')} · ${t('billing_label_account')}: ${issuer.bankAccount} · ${t('billing_label_holder')}: ${issuer.bankHolder}`;
    for (const l of wrap(bankLine, regular, 9.5, x1 - x0 - 28)) { text(l, x0 + 14, by, { size: 9.5 }); by -= 13; }
    text(`${t('billing_label_reference')}: ${inv.invoiceNo}`, x0 + 14, by, { font: bold, size: 9.5 });
    y -= 104;

    // VAT and signature
    for (const l of wrap(t('billing_doc_vat'), regular, 9, x1 - x0)) { text(l, x0, y, { size: 9, color: muted }); y -= 12; }
    y -= 28;
    const sig = t('billing_doc_signature');
    text(sig, x0, y, { font: bold, size: 10.5 });
    const sx = x0 + bold.widthOfTextAtSize(sig, 10.5) + 10;
    page.drawLine({ start: { x: sx, y: y - 2 }, end: { x: sx + 150, y: y - 2 }, thickness: 0.8, color: ink });
    text(`/${issuer.name}/`, sx + 160, y, { size: 10.5 });

    // Footer
    page.drawLine({ start: { x: x0, y: 58 }, end: { x: x1, y: 58 }, thickness: 0.6, color: line });
    const foot = `${issuer.name} · DalaTech · ${t('billing_label_phone')}: ${issuer.phone} · ${t('billing_label_email')}: ${issuer.email}`;
    for (const [i, l] of wrap(foot, regular, 8.5, x1 - x0).entries()) text(l, x0, 44 - i * 11, { size: 8.5, color: muted });

    const bytes = await doc.save({ useObjectStreams: false });
    return { ok: true, base64: Buffer.from(bytes).toString('base64'), name: `DalaTech-${inv.invoiceNo}.pdf` };
  } catch (err) {
    if (err instanceof Refused) return { ok: false, why: err.message };
    throw err;
  }
}
