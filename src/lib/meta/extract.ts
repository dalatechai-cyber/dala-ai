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
 * ## What each skip carries, and why it is not just a reason
 *
 * This file used to return a bare list of reasons, and the caller wrote them to one
 * `console.info`. That satisfied the sentence "everything skipped is reported" and nothing
 * else: no `quality_flags` row, no `messages` row, nothing in the digest. On the mirror's
 * first full trading day three of fourteen deliveries were skipped here, and the only way
 * to learn what they had been was to read `webhook_events.raw_payload` by hand.
 *
 * That is this repository's own recurring shape — a comment asserting a safety property
 * that no mechanism provides — sitting in the docstring above. So a skip now carries what
 * a person would need to judge it later: which event and which index (so the record is
 * idempotent across QStash retries), Meta's `mid`, and **what kind of thing it was**.
 * `inbound/dropped.ts` turns that into a row.
 */
import { nfc } from '../mn/text.ts';

export type InboundMessage = {
  /** The PSID (Messenger) or IGSID (Instagram). Page-scoped, and PII. */
  senderId: string;
  /** Meta's message id, `mid.…`. The idempotency key for the `messages` row. */
  externalId: string;
  text: string;
  sentAt: Date;
  /**
   * Attachment kinds on a message that ALSO carries text — the captioned case.
   *
   * This existed and was thrown away (D-083). `attachmentKinds()` has always run for every
   * message and bound its result into `carried`, but `carried` was only ever used on the
   * skip paths, so a message with text pushed four fields and lost the rest. A customer who
   * sends a photograph with «Ийм болгож болох уу?» — *can you do it like this?* — therefore
   * reached the model as those five words and nothing else, and the model answered about a
   * picture it cannot see and did not know existed.
   *
   * Empty for an ordinary text message, which is the overwhelming majority.
   */
  attachments: string[];
  /** Sticker asset ids, when the attachments were stickers. Not PII. @see attachmentKinds */
  stickerIds: string[];
};

export type SkipReason = 'echo' | 'no_text' | 'status_event' | 'postback' | 'malformed';

/** One messaging event we chose not to answer, with enough about it to judge that later. */
export type SkippedEvent = {
  reason: SkipReason;
  /**
   * Position within `entry.messaging`. With the event id this is a stable identity for the
   * skip — Meta's `mid` is absent on a malformed event, and a QStash retry re-parses the
   * same payload, so the pair is what stops a retry recording the same loss twice.
   */
  idx: number;
  /** Meta's `mid`, when the event carried one. */
  externalId: string | null;
  /**
   * The PSID, when known. PII: it exists here so a dropped event can be tied to the
   * conversation it belongs to. It must never reach a log line.
   */
  senderId: string | null;
  /**
   * The OTHER party's id, when the event carried one. On an `echo` this is the customer:
   * an echo's `sender` is the Page itself, so `senderId` is the wrong end of the thread
   * for finding the conversation it belongs to, and reusing that field would quietly file
   * a page id where a PSID is expected. Null on every other reason. PII, like `senderId`.
   */
  recipientId: string | null;
  /**
   * The Meta APP id that sent an echo, when the payload named one. Null on every other
   * reason, and null on an echo Meta attributed to no app.
   *
   * ## This is the difference between "not ours" and "a person"
   *
   * `controlFromEcho` concluded `human` from an echo whose `mid` is not one of our sends,
   * and on Matrix's Page that inference is false for a reason nothing in the payload used
   * to expose: the ancestor bot answers every thread through a DIFFERENT Meta app, so
   * every one of its replies is an echo that is not ours and is not a person either.
   * Measured 2026-09-21 on the first real echo — `app_id 1380702870025418`, the
   * `dalatech` app that holds the ancestor's callback, against our `1562862634970492`.
   *
   * PRECISION NOTE: Meta sends this as a JSON number. `JSON.parse` has already turned it
   * into a double by the time this function runs, so an app id above 2^53 would arrive
   * corrupted and nothing here could tell. Both ids in play are ~1.5e15, well inside the
   * safe range; a future id near the limit is a hazard this layer cannot see.
   */
  appId: string | null;
  /**
   * When Meta says an ECHO was sent — its own `timestamp`, the same clock as a customer
   * message's `sentAt`. Null on every other reason, and null on an echo with no timestamp.
   *
   * It exists so "did the Page answer this customer after they wrote?" can be asked on ONE
   * clock. `webhook_events.received_at` is ours, and measuring a reply from Meta's clock on
   * one side and ours on the other is the error `scripts/mirror/side-by-side.sql` documents:
   * the receipt hop was 1.3–6.4 s, larger than some of the gaps being measured.
   */
  sentAt: Date | null;
  /** Attachment kinds, deduplicated — see `attachmentKinds`. Empty for a text-less skip. */
  attachments: string[];
  /** Facebook sticker asset ids, when the attachments were stickers. Not PII. */
  stickerIds: string[];
};

export type ExtractResult = {
  messages: InboundMessage[];
  /** One entry per messaging event we chose not to answer, with the reason. */
  skipped: SkippedEvent[];
  /**
   * Messages Meta delivered into `entry.standby` — i.e. addressed to us as a **secondary
   * receiver** (§3.7). Not a skip and not a drop: it is a channel-level misconfiguration,
   * and the caller must alert rather than continue.
   *
   * ## Why this is counted rather than ignored
   *
   * When a Page has the Page Inbox app as primary receiver — the default for many Pages,
   * and the state a Page enters the moment anyone touches "Automated responses" — Meta
   * stops populating `entry.messaging` and populates `entry.standby` instead. Until now
   * this function read `entry['messaging']`, found it absent, and returned an EMPTY result
   * with **no skip recorded**: byte-identical to an entry that carried no customer message
   * at all.
   *
   * That is §3.7's whole point. The webhook is well-formed, correctly signed, correctly
   * routed for the right tenant; we return 200; Reception answers nobody; and every health
   * signal stays green. `health/channel.ts` catches it eventually by noticing that webhooks
   * arrive and messages do not — but eventually is three open hours later, and here it is
   * knowable at the instant it happens.
   */
  standby: number;
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * What the customer actually attached, as kinds. Never the CDN url: that is customer
 * content, and `webhook_events.raw_payload` already holds it under its own retention.
 *
 * ## Meta sends one sticker as TWO attachments, and they are not two things
 *
 * A thumbs-up arrives as `[{type:'image', payload:{sticker_id}}, {type:'sticker',
 * payload:{sticker_id}}]` — the same `sticker_id` twice, once declared as an image.
 * Counting the array says the customer sent two attachments. Reading only `type` says one
 * of them was a photograph. Both are wrong, and the second is the one that costs: a
 * thumbs-up is filler, and a photograph of the colour someone wants is the most valuable
 * message a salon can receive. Telling them apart is the whole reason this function
 * exists, and the `sticker_id` in the PAYLOAD is the only field that does it — so it
 * decides the kind, and the duplicate collapses.
 *
 * Measured: on 2026-09-14 all three of Matrix's skipped attachments were `sticker_id`
 * 369239263222822, the same thumbs-up, and each one read as an `image` from the type alone.
 */
export function attachmentKinds(message: Record<string, unknown>): { kinds: string[]; stickerIds: string[] } {
  const raw = message['attachments'];
  if (!Array.isArray(raw)) return { kinds: [], stickerIds: [] };

  const kinds: string[] = [];
  const stickerIds: string[] = [];
  for (const item of raw) {
    const att = asRecord(item);
    if (att === null) { if (!kinds.includes('malformed')) kinds.push('malformed'); continue; }
    const payload = asRecord(att['payload']);
    const stickerId = payload === null ? undefined : payload['sticker_id'];
    if (stickerId !== undefined && stickerId !== null) {
      const id = String(stickerId);
      if (!stickerIds.includes(id)) stickerIds.push(id);
      if (!kinds.includes('sticker')) kinds.push('sticker');
      continue;
    }
    // `?? 'unknown'` rather than dropping it: an attachment whose type Meta has not
    // documented yet is still a customer sending us something, and a kind nobody
    // recognises is a better record than an empty list that reads as "no attachment".
    const kind = typeof att['type'] === 'string' && att['type'] !== '' ? att['type'] : 'unknown';
    if (!kinds.includes(kind)) kinds.push(kind);
  }
  return { kinds, stickerIds };
}

export function extractInboundMessages(entry: unknown): ExtractResult {
  const messages: InboundMessage[] = [];
  const skipped: SkippedEvent[] = [];

  const e = asRecord(entry);
  // Counted before the `messaging` check, because the two are mutually exclusive in
  // practice and the early return below would otherwise skip past it.
  const standbyEvents = e === null ? null : e['standby'];
  const standby = Array.isArray(standbyEvents) ? standbyEvents.length : 0;

  const events = e === null ? null : e['messaging'];
  if (!Array.isArray(events)) return { messages, skipped, standby };

  for (const [idx, raw] of events.entries()) {
    // Every skip is built through this, so no branch can record less than another. The
    // fields default to "not known here" rather than to a plausible blank.
    const skip = (
      reason: SkipReason,
      extra: Partial<Omit<SkippedEvent, 'reason' | 'idx'>> = {},
    ): void => {
      skipped.push({
        reason, idx,
        externalId: extra.externalId ?? null,
        senderId: extra.senderId ?? null,
        recipientId: extra.recipientId ?? null,
        appId: extra.appId ?? null,
        sentAt: extra.sentAt ?? null,
        attachments: extra.attachments ?? [],
        stickerIds: extra.stickerIds ?? [],
      });
    };

    const ev = asRecord(raw);
    if (ev === null) { skip('malformed'); continue; }

    const senderOf = asRecord(ev['sender']);
    const senderIdOf = senderOf === null ? '' : String(senderOf['id'] ?? '');
    const recipientOf = asRecord(ev['recipient']);
    const recipientIdOf = recipientOf === null ? '' : String(recipientOf['id'] ?? '');

    if ('delivery' in ev || 'read' in ev) { skip('status_event'); continue; }
    if ('postback' in ev) {
      skip('postback', { senderId: senderIdOf === '' ? null : senderIdOf });
      continue;
    }

    const message = asRecord(ev['message']);
    if (message === null) { skip('status_event'); continue; }

    const externalId = String(message['mid'] ?? '');

    // An outbound message on this thread, delivered back to us. Answering it is a loop
    // that bills — that has always been the reason to skip it, and it still is.
    //
    // What changed is that the skip now CARRIES the `mid` and the customer. An echo whose
    // `mid` is not one of our own sends is a person typing in the salon's inbox, and it is
    // the only detector that works while another app owns the thread (§3.7.3). Carrying
    // nothing made that question unaskable, so the bot kept answering alongside the
    // receptionist and nothing anywhere recorded that it was happening.
    //
    // `sender` on an echo is the PAGE, so the customer is the RECIPIENT. Filing the page
    // id under `senderId` would look right and resolve to no conversation.
    if (message['is_echo'] === true) {
      // Meta sends `app_id` as a NUMBER. Both forms are accepted because the same id
      // arrives as a string elsewhere in this payload family, and one shape silently
      // yielding null is exactly the "absent means human" reading that must not happen.
      const rawAppId = message['app_id'];
      const appId = typeof rawAppId === 'string' && rawAppId.trim() !== ''
        ? rawAppId
        : (typeof rawAppId === 'number' && Number.isFinite(rawAppId) ? String(rawAppId) : null);
      const echoTs = ev['timestamp'];
      skip('echo', {
        externalId: externalId === '' ? null : externalId,
        senderId: senderIdOf === '' ? null : senderIdOf,
        recipientId: recipientIdOf === '' ? null : recipientIdOf,
        appId,
        sentAt: typeof echoTs === 'number' && Number.isFinite(echoTs) ? new Date(echoTs) : null,
      });
      continue;
    }

    const senderId = senderIdOf;
    const text = typeof message['text'] === 'string' ? nfc(message['text']) : '';
    const { kinds, stickerIds } = attachmentKinds(message);
    const carried = {
      externalId: externalId === '' ? null : externalId,
      senderId: senderId === '' ? null : senderId,
      attachments: kinds,
      stickerIds,
    };

    if (senderId === '') { skip('malformed', carried); continue; }
    // An attachment with no text carries no question. V1 answers text — but a thumbs-up
    // and a photograph of the colour someone wants both land here, and only one of them is
    // filler, so the KINDS go with the skip rather than the fact of it.
    if (text.trim() === '') { skip('no_text', carried); continue; }

    // Meta's timestamps are milliseconds. A missing one is treated as "now" by the
    // caller rather than as 1970, which would make every such event look stale and be
    // dropped — a silent, total outage for whatever produced it.
    const ts = ev['timestamp'];
    const sentAt = typeof ts === 'number' && Number.isFinite(ts) ? new Date(ts) : new Date(NaN);

    // `kinds` and `stickerIds` were computed above for `carried` and then dropped here for
    // every message that had text. That silent discard is D-083; see `InboundMessage`.
    messages.push({ senderId, externalId, text, sentAt, attachments: kinds, stickerIds });
  }

  return { messages, skipped, standby };
}
