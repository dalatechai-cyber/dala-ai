/**
 * What makes one Meta delivery different from another.
 *
 * ## The key this replaces, and how it was found
 *
 * `webhook_events.dedup_key` was
 *
 * ```
 * `${externalId}:${input.index}:${input.bodyBytes}:${input.matchedAppSlug}`
 * ```
 *
 * and `unique (provider, dedup_key)` is **global and permanent** — `purge_after` exists on
 * the table and nothing writes it. So for one Page, on one app, the only thing that varied
 * between two events was the byte length of the request body.
 *
 * That is not a hypothesis. Every real Meta delivery this platform has ever received was
 * read back out of the project on 2026-09-06:
 *
 * | body bytes | customer text |
 * |---|---|
 * | 310 | `yoo` |
 * | 313 | `hi bro` |
 *
 * `310 - 3 = 307`. `313 - 6 = 307`. Both `mid` values are exactly 88 characters; the page
 * id, the PSID and both timestamps are fixed width. The envelope is a constant, so
 *
 * ```
 * body_bytes = 307 + utf8_length(customer text)
 * ```
 *
 * and the key reduced to **`{page}:0:{307 + text_bytes}:{app}`**. Two customers writing
 * messages of the same byte length collide — «Сайн байна уу» is 24 bytes, and so is every
 * other 24-byte message. The second one is answered `200`, logged at `info`, and never
 * replied to, for ever. At Matrix's measured ~60 messages/day the common greeting lengths
 * are used up within hours, and a used length never comes back.
 *
 * The four events on record all happened to differ in length, which is why nothing noticed.
 *
 * ## What it keys on now
 *
 * **Meta's own identifiers for the things inside the entry** — `message.mid` for messages
 * (in `messaging` and in `standby`), `value.comment_id` for feed changes. Those are the
 * identity of the event as far as Meta is concerned: a redelivery carries the same ones,
 * and no two distinct messages ever share one. `ClaimInput.dedupKey` has documented itself
 * as "Meta's message id where present" since it was written; this is the first version
 * where that sentence is true.
 *
 * They are sorted (order within an entry is not a promise anyone has made) and hashed,
 * because the key goes into a btree unique index and a handful of 88-character mids would
 * approach its row limit. 128 bits of SHA-256 is not a collision risk in a table that will
 * hold millions of rows at most; body length was one of a few hundred values.
 *
 * ## The fallback, and why it is safe where it applies
 *
 * An entry can carry nothing with an id — delivery receipts, read receipts, postbacks. For
 * those the key is a digest of the entry's own JSON, which is stable across a redelivery
 * because Meta resends the identical bytes.
 *
 * That is a weaker guarantee than a mid, and it is deliberately applied only where nothing
 * can be sent: `meta/extract.ts` skips receipts and postbacks, so the worst case is that a
 * receipt is claimed twice and does nothing twice. Everything that can produce a reply —
 * a message, an echo, a comment — has an identifier and takes the first branch.
 *
 * ## This is not the exactly-once guarantee, and must not be described as one
 *
 * `outbound_messages_dedup` on `(tenant_id, kind, dedup_key)` is, and the reply's own key
 * is derived from the customer message's mid (D-029/D-030). An event claimed twice still
 * cannot produce two replies. What the event key buys is that a *different* message is
 * never mistaken for a redelivery of an earlier one — which is the direction that was
 * broken, and the direction no downstream key can recover from, because the second message
 * never reaches them at all.
 */
import { createHash } from 'node:crypto';

/** Meta's shape, as much of it as identity needs. */
type Entryish = { messaging?: unknown; standby?: unknown; changes?: unknown };

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asRecord = (v: unknown): Record<string, unknown> =>
  (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});

function nonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/**
 * Every Meta-assigned identifier in this entry, sorted.
 *
 * Exported so the test can assert WHICH ids were found, not merely that two entries
 * differ — a digest test passes just as happily when the extraction silently finds
 * nothing and both sides fall through to the fallback.
 */
export function entryEventIds(entry: unknown): string[] {
  const e = asRecord(entry) as Entryish;
  const ids: string[] = [];

  for (const key of ['messaging', 'standby'] as const) {
    for (const raw of asArray(e[key])) {
      const mid = nonEmptyString(asRecord(asRecord(raw)['message'])['mid']);
      if (mid !== null) ids.push(mid);
    }
  }
  for (const raw of asArray(e.changes)) {
    const commentId = nonEmptyString(asRecord(asRecord(raw)['value'])['comment_id']);
    if (commentId !== null) ids.push(commentId);
  }

  // Sorted by code point, never by locale — this string reaches a database key, and
  // `check-deterministic-order.mjs` exists because ordering that reaches a hash must not
  // depend on the runtime.
  return ids.sort();
}

export type EntryIdentity = {
  /** `ids` when Meta named the contents; `digest` when it named nothing (receipts). */
  kind: 'ids' | 'digest';
  /** What was hashed, for the `ids` case. Empty for `digest`. */
  ids: readonly string[];
  /** 128 bits of SHA-256, hex. */
  digest: string;
};

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 32);

/**
 * U+0000, written as an escape because a literal one does not survive every editor.
 * A separator that cannot occur in a Meta id, so no set of ids can be re-parenthesised
 * into a different set that hashes the same. A space would very probably do — mids are
 * base64url, comment ids are digits and an underscore — but "very probably" is what the
 * key this replaces was built on.
 */
const SEP = '\u0000';

export function entryIdentity(entry: unknown): EntryIdentity {
  const ids = entryEventIds(entry);
  if (ids.length > 0) return { kind: 'ids', ids, digest: sha(ids.join(SEP)) };
  return { kind: 'digest', ids: [], digest: sha(JSON.stringify(entry ?? null)) };
}

/**
 * The `webhook_events.dedup_key` for one entry of one delivery.
 *
 * `externalId` and `index` stay in front of the digest. The Page id makes a key legible in
 * a table somebody is debugging at 2am, and the index preserves the property the old key
 * had for free: two entries in one POST cannot collide, including the receipts-only case
 * where both would otherwise digest identically.
 *
 * The `m`/`d` prefix names which branch produced the digest, so a key can be read back
 * without re-deriving it.
 */
export function dedupKeyForEntry(input: {
  externalId: string;
  index: number;
  entry: unknown;
  matchedAppSlug: string;
}): string {
  const identity = entryIdentity(input.entry);
  const tag = identity.kind === 'ids' ? 'm' : 'd';
  return `${input.externalId}:${input.index}:${tag}${identity.digest}:${input.matchedAppSlug}`;
}
