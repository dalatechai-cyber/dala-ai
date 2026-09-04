/**
 * Pull the answerable customer messages out of one Meta webhook entry.
 *
 * The entry is stored whole on `webhook_events.raw_payload`, so this reads the payload
 * rather than trusting a copy carried in the job. One source, parsed once, at the point
 * of use.
 *
 * ## What must be skipped, and why each one matters
 *
 *  - **`is_echo`.** Meta delivers our OWN outbound messages back to us. Answering them
 *    makes the bot reply to itself, forever, at full price. This is the single most
 *    expensive thing that can go wrong in this file.
 *  - **`delivery` and `read` receipts.** Status events with no message. Treating one as a
 *    customer turn puts an empty message in front of the model.
 *  - **Attachments with no text.** A sticker or a photo carries no question. V1 answers
 *    text; a reply to a sticker would be invented from nothing.
 *  - **`postback`.** Button payloads are a different product surface with their own
 *    routing, and V1 does not ship one.
 *
 * Everything skipped is *reported*, not silently dropped: the caller marks the event
 * processed with a reason, so "we saw it and chose not to answer" is distinguishable from
 * "it vanished".
 */
import { nfc } from '../mn/text.ts';

export type InboundMessage = {
  /** The PSID (Messenger) or IGSID (Instagram). Page-scoped, and PII. */
  senderId: string;
  /** Meta's message id, `mid.…`. The idempotency key for the `messages` row. */
  externalId: string;
  text: string;
  sentAt: Date;
};

export type SkipReason = 'echo' | 'no_text' | 'status_event' | 'postback' | 'malformed';

export type ExtractResult = {
  messages: InboundMessage[];
  /** One entry per messaging event we chose not to answer, with the reason. */
  skipped: SkipReason[];
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function extractInboundMessages(entry: unknown): ExtractResult {
  const messages: InboundMessage[] = [];
  const skipped: SkipReason[] = [];

  const e = asRecord(entry);
  const events = e === null ? null : e['messaging'];
  if (!Array.isArray(events)) return { messages, skipped };

  for (const raw of events) {
    const ev = asRecord(raw);
    if (ev === null) { skipped.push('malformed'); continue; }

    if ('delivery' in ev || 'read' in ev) { skipped.push('status_event'); continue; }
    if ('postback' in ev) { skipped.push('postback'); continue; }

    const message = asRecord(ev['message']);
    if (message === null) { skipped.push('status_event'); continue; }

    // OUR OWN message, delivered back to us. Answering it is a loop that bills.
    if (message['is_echo'] === true) { skipped.push('echo'); continue; }

    const sender = asRecord(ev['sender']);
    const senderId = sender === null ? '' : String(sender['id'] ?? '');
    const externalId = String(message['mid'] ?? '');
    const text = typeof message['text'] === 'string' ? nfc(message['text']) : '';

    if (senderId === '') { skipped.push('malformed'); continue; }
    // An attachment with no text carries no question. Reported, never answered blind.
    if (text.trim() === '') { skipped.push('no_text'); continue; }

    // Meta's timestamps are milliseconds. A missing one is treated as "now" by the
    // caller rather than as 1970, which would make every such event look stale and be
    // dropped — a silent, total outage for whatever produced it.
    const ts = ev['timestamp'];
    const sentAt = typeof ts === 'number' && Number.isFinite(ts) ? new Date(ts) : new Date(NaN);

    messages.push({ senderId, externalId, text, sentAt });
  }

  return { messages, skipped };
}
