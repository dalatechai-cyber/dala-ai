/**
 * A reply with a web address, as text plus link BUTTONS instead of a preview card (D-143).
 *
 * Founder, 2026-09-26: on Messenger and on Instagram, a text message carrying
 * `https://app.dalatech.online` gets a large link-preview card from Meta — the site's logo
 * and title under the text — and the whole message reads as one big clickable block. The
 * Send API has no switch to turn the preview off for a text message. What both channels do
 * support is the BUTTON TEMPLATE: up to 640 characters of text with one to three `web_url`
 * buttons under it (Messenger's Send API reference; Instagram's messaging reference lists
 * the same template, text ≤ 640, 1–3 buttons). A template renders as a normal bubble with a
 * small tappable button, and no preview card is generated for it.
 *
 * So the reply's WORDS are kept exactly, and only the address moves:
 *
 *  - an address that ends its line («👉 Бусад AI ажилтнууд: https://dalatech.online») is
 *    lifted out of the text, and the line keeps everything before it;
 *  - an address inside a sentence («… https://dalatech.online хуудаснаас …») is written as
 *    its bare host, so the sentence still reads, and the link is on the button.
 *
 * The button's label is the address's own host (`app.dalatech.online`), never a new word:
 * a label is text a customer reads, and platform Mongolian is signed by the founder. The
 * stored reply is unchanged — this is how it is SENT, decided at the wire.
 */
import { extractUrls } from '../mn/extract.ts';

/** Meta's button-template limits (Messenger and Instagram alike). */
export const BUTTON_TEMPLATE_MAX_TEXT_CHARS = 640;
export const MAX_LINK_BUTTONS = 3;
export const BUTTON_TITLE_MAX_CHARS = 20;

export type LinkButton = { url: string; title: string };
export type LinkButtonMessage = { text: string; buttons: LinkButton[] };

/** Trailing characters a sentence puts after a URL (the same set `mn/extract.ts` strips). */
const TRAILING = /^[.,;:!?)»】\]'"…]*\s*$/u;

function withScheme(raw: string): string {
  return /^https?:\/\//iu.test(raw) ? raw : `https://${raw}`;
}

/** `https://www.example.com/` → `example.com`; a path is kept, a trailing slash is not. */
export function displayAddress(raw: string): string {
  let u: URL;
  try {
    u = new URL(withScheme(raw));
  } catch {
    return raw;
  }
  const host = u.hostname.replace(/^www\./iu, '');
  const path = `${u.pathname}${u.search}`.replace(/\/$/u, '');
  return `${host}${path}`;
}

/** The button label: the host alone, cut to Meta's 20 characters. */
export function buttonTitle(raw: string): string {
  let host: string;
  try {
    host = new URL(withScheme(raw)).hostname.replace(/^www\./iu, '');
  } catch {
    host = raw;
  }
  const cps = [...host];
  return cps.length <= BUTTON_TITLE_MAX_CHARS ? host : `${cps.slice(0, BUTTON_TITLE_MAX_CHARS - 1).join('')}…`;
}

/**
 * The reply as template text plus buttons, or `null` when it should go as plain text: no
 * address in it, or more distinct addresses than a template has buttons (no link is ever
 * dropped to make it fit).
 */
export function linkButtonMessage(body: string): LinkButtonMessage | null {
  // A Mongolian case suffix written onto an address («dalatech.online-д») is part of the
  // sentence, not of the link: it stays in the text and never reaches the button's URL.
  const found = [...new Set(extractUrls(body).map((u) => u.replace(/-\p{Script=Cyrillic}+$/u, '')))];
  if (found.length === 0 || found.length > MAX_LINK_BUTTONS) return null;
  // Longest first, so `https://x.mn` is never matched inside `https://x.mn/page`.
  const urls = [...found].sort((a, b) => b.length - a.length);

  const lines = body.split('\n').map((line) => {
    let out = line;
    for (const url of urls) {
      for (let at = out.indexOf(url); at !== -1; at = out.indexOf(url)) {
        const after = out.slice(at + url.length);
        out = TRAILING.test(after)
          // The address ends its line: lift it out, with the punctuation that closed it.
          ? out.slice(0, at).trimEnd()
          // Inside a sentence: its bare host, so the sentence still reads.
          : `${out.slice(0, at)}${displayAddress(url)}${after}`;
      }
    }
    return out;
  });
  const text = lines
    .filter((l, i) => !(l.trim() === '' && (lines[i - 1] ?? '').trim() === ''))
    .join('\n')
    .trim();

  return {
    // A reply that was nothing but an address still needs text above its button.
    text: text === '' ? displayAddress(found[0] as string) : text,
    // In the order the reply mentions them.
    buttons: found.map((url) => ({ url: withScheme(url), title: buttonTitle(url) })),
  };
}
