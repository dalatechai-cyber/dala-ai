/**
 * The two ways a billing message leaves: e-mail to the client (Brevo) and Telegram to the
 * founder. Each returns one of three outcomes, and the outbox acts on the difference:
 *
 * - `sent` — the provider accepted it (a 2xx is "accepted", never "delivered"; the id is
 *   kept so it can be found in the provider's log).
 * - `retry` — the provider answered and did NOT accept it (429, 5xx). Sending again cannot
 *   produce a duplicate, so the outbox retries with a backoff.
 * - `terminal` — the provider refused it for a reason a retry will not fix (400, 401, a bad
 *   address). Kept, visible, and the founder is told.
 * - `unknown` — no answer (timeout, connection lost). It may have gone out. It is NOT
 *   retried: the row stays claimed, the sweep marks it `unknown`, and the founder decides.
 *   A duplicate invoice e-mail is exactly what the founder asked never to happen.
 *
 * ## The e-mail sender
 *
 * `hello@dalatech.online` is on the DKIM/SPF-authenticated apex domain, the sender Core
 * Language uses (its CLAUDE.md: Brevo accepts a send from an unauthenticated domain with a
 * 2xx and drops it). Since 2026-10-01 it receives mail: ImprovMX forwards it to the founder's
 * DalaTech inbox (founder, 2026-10-02), which is why the e-mail footer may name it. Every
 * billing e-mail still carries `Reply-To: BILLING_FOUNDER_EMAIL`, so a client who answers an
 * invoice reaches the founder directly.
 *
 * ## Brevo or Resend (0070)
 *
 * Brevo adds a List-Unsubscribe header to every message and does not remove it below its
 * Enterprise plan, so Gmail shows "Unsubscribe" beside an invoice; a client who presses it
 * is blocklisted, and their next invoice is accepted with a 2xx and never delivered. Resend
 * adds no such header, and dalatech.online is already DKIM-signed through it (selector
 * `resend`, the dalatech-online site's e-mails pass SPF, DKIM and DMARC at Gmail). The
 * founder chooses with `BILLING_EMAIL_VIA` (`config.ts`); both have the same sender,
 * Reply-To and outcomes.
 */
import { required } from '../env.ts';

export type SendOutcome =
  | { outcome: 'sent'; providerMessageId: string }
  | { outcome: 'retry' | 'terminal' | 'unknown'; detail: string };

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  /** The HTML version (0070). Absent: the text as simple HTML. */
  html?: string;
  /** `utf8`: `content` is text (the CSV ledger). `base64`: `content` is the bytes (the PDF). */
  attachment?: { name: string; content: string; encoding?: 'utf8' | 'base64' };
};

function attachmentBase64(a: NonNullable<EmailMessage['attachment']>): string {
  return a.encoding === 'base64' ? a.content : Buffer.from(a.content, 'utf8').toString('base64');
}

export type TelegramMessage = { text: string; button?: { label: string; url: string } };

export const EMAIL_SENDER = { name: 'DalaTech', email: 'hello@dalatech.online' } as const;
const TIMEOUT_MS = 15_000;
const TELEGRAM_LIMIT = 4000;

function escapeHtml(s: string): string {
  return s.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');
}

/** Plain text as simple HTML: escaped, line breaks kept, URLs made tappable. */
export function textToHtml(text: string): string {
  const linked = escapeHtml(text).replace(/https:\/\/[^\s<]+/gu, (url) => `<a href="${url}">${url}</a>`);
  return `<!DOCTYPE html><html lang="mn"><head><meta charset="utf-8"></head>`
    + `<body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#111">`
    + `${linked.replace(/\n/gu, '<br>')}</body></html>`;
}

/**
 * The provider's own reason for a refusal (`{"message": …}` from Brevo and Resend), so a
 * failed send says what to fix («domain is not verified», «key restricted to …») rather
 * than only a status code. Their error bodies carry no credential; it is still cut short,
 * flattened to one line, and never throws.
 */
async function providerReason(res: Response): Promise<string> {
  try {
    const raw = (await res.text()).slice(0, 2000);
    let msg = raw;
    try {
      const j = JSON.parse(raw) as { message?: unknown; name?: unknown; code?: unknown };
      msg = [j.name ?? j.code, j.message].filter((x) => typeof x === 'string' && x !== '').join(': ') || raw;
    } catch {
      // not JSON: the raw text
    }
    const one = msg.replace(/\s+/gu, ' ').trim().slice(0, 240);
    return one === '' ? '' : ` — ${one}`;
  } catch {
    return '';
  }
}

function classify(status: number): 'retry' | 'terminal' {
  return status === 429 || status >= 500 ? 'retry' : 'terminal';
}

export async function sendBrevoEmail(msg: EmailMessage, fetchImpl: typeof fetch = fetch): Promise<SendOutcome> {
  let apiKey: string;
  let replyTo: string;
  try {
    apiKey = required('BREVO_API_KEY');
    replyTo = required('BILLING_FOUNDER_EMAIL');
  } catch (err) {
    return { outcome: 'terminal', detail: err instanceof Error ? err.message : String(err) };
  }
  let res: Response;
  try {
    res = await fetchImpl('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: EMAIL_SENDER,
        to: [{ email: msg.to }],
        replyTo: { email: replyTo },
        subject: msg.subject,
        textContent: msg.text,
        htmlContent: msg.html ?? textToHtml(msg.text),
        ...(msg.attachment === undefined ? {} : {
          attachment: [{ name: msg.attachment.name, content: attachmentBase64(msg.attachment) }],
        }),
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { outcome: 'unknown', detail: `brevo: ${err instanceof Error ? err.name : 'error'}` };
  }
  if (!res.ok) return { outcome: classify(res.status), detail: `brevo HTTP ${res.status}${await providerReason(res)}` };
  const body = (await res.json().catch(() => null)) as { messageId?: unknown } | null;
  return { outcome: 'sent', providerMessageId: typeof body?.messageId === 'string' ? body.messageId : '' };
}

/**
 * The same message through Resend (0070, `BILLING_EMAIL_VIA=resend`). Resend adds no
 * List-Unsubscribe header, so an invoice reads as the transactional message it is. The
 * sender, Reply-To and the three outcomes are exactly Brevo's.
 */
export async function sendResendEmail(msg: EmailMessage, fetchImpl: typeof fetch = fetch): Promise<SendOutcome> {
  let apiKey: string;
  let replyTo: string;
  try {
    apiKey = required('RESEND_API_KEY');
    replyTo = required('BILLING_FOUNDER_EMAIL');
  } catch (err) {
    return { outcome: 'terminal', detail: err instanceof Error ? err.message : String(err) };
  }
  let res: Response;
  try {
    res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        from: `${EMAIL_SENDER.name} <${EMAIL_SENDER.email}>`,
        to: [msg.to],
        reply_to: replyTo,
        subject: msg.subject,
        text: msg.text,
        html: msg.html ?? textToHtml(msg.text),
        ...(msg.attachment === undefined ? {} : {
          attachments: [{ filename: msg.attachment.name, content: attachmentBase64(msg.attachment) }],
        }),
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { outcome: 'unknown', detail: `resend: ${err instanceof Error ? err.name : 'error'}` };
  }
  if (!res.ok) return { outcome: classify(res.status), detail: `resend HTTP ${res.status}${await providerReason(res)}` };
  const body = (await res.json().catch(() => null)) as { id?: unknown } | null;
  return { outcome: 'sent', providerMessageId: typeof body?.id === 'string' ? body.id : '' };
}

/** Telegram to the founder's alert chat, with an optional button that opens a link. */
export async function sendFounderTelegram(msg: TelegramMessage, fetchImpl: typeof fetch = fetch): Promise<SendOutcome> {
  if (process.env['ALERTS_ENABLED'] === 'false') return { outcome: 'terminal', detail: 'ALERTS_ENABLED=false' };
  let token: string;
  let chat: string;
  try {
    token = required('TELEGRAM_BOT_TOKEN');
    chat = required('TELEGRAM_ALERT_CHAT_ID');
  } catch (err) {
    return { outcome: 'terminal', detail: err instanceof Error ? err.message : String(err) };
  }
  const text = [...msg.text].length > TELEGRAM_LIMIT ? `${[...msg.text].slice(0, TELEGRAM_LIMIT).join('')}\n…(cut)` : msg.text;
  let res: Response;
  try {
    res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chat,
        text,
        disable_web_page_preview: true,
        ...(msg.button === undefined ? {} : { reply_markup: { inline_keyboard: [[{ text: msg.button.label, url: msg.button.url }]] } }),
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { outcome: 'unknown', detail: `telegram: ${err instanceof Error ? err.name : 'error'}` };
  }
  if (!res.ok) return { outcome: classify(res.status), detail: `telegram HTTP ${res.status}` };
  const body = (await res.json().catch(() => null)) as { result?: { message_id?: unknown } } | null;
  return { outcome: 'sent', providerMessageId: String(body?.result?.message_id ?? '') };
}
