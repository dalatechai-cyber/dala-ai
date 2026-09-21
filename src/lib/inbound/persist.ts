/**
 * Inbound persistence (V1.md 3.7): contact → conversation → message, and the history read.
 *
 * The gap the plan did not have a row for. Every row of Track 3 assumed the customer's
 * text was simply available to the worker; the webhook stored `webhook_events.raw_payload`
 * and stopped. This is the layer between them.
 *
 * ## The PSID is PII, and the schema says so
 *
 * `person_identities.value_hash` is `bytea` with the comment "a PSID is a stable person
 * identifier, i.e. PII". A **plain** SHA-256 would not honour that: a Meta PSID is a
 * ~16-digit number, so the whole space is 10^16 and a fast hash is brute-forceable on
 * commodity hardware. Anyone who obtained the table could recover every PSID and rejoin
 * them to Facebook profiles.
 *
 * So it is an HMAC under a platform pepper. That does not make the value secret — it makes
 * the hash **unusable without the key**, which is the property the column is for. The
 * pepper is a platform secret, never per-tenant: two tenants who both talk to the same
 * person must produce different `contacts` rows (a PSID is Page-scoped) but the same
 * `persons` row is deliberately *not* shared across tenants either, so no cross-tenant
 * correlation is possible in the first place.
 */
import { createHmac } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { required } from '../env.ts';
import { nfc } from '../mn/text.ts';
import type { AnsweredBy } from '../reception/handle.ts';

/**
 * How long a quiet conversation stays the same conversation.
 *
 * Matches Messenger's own 24-hour messaging window, and the ancestor's Redis TTL, so the
 * three agree rather than drifting. **It is also the definition of the unit Reception is
 * sold in** — D-015's 400-conversation band counts these rows, so a shorter window sells
 * fewer conversations for the same traffic and a longer one sells more. Changing it is a
 * pricing change wearing a code change's clothes.
 */
export const CONVERSATION_IDLE_MS = 24 * 60 * 60 * 1000;

/** Every conversation state that is not finished. */
const OPEN_STATES = ['active', 'awaiting_human', 'human_handled', 'paused_budget', 'paused_role_off'];

export type PersistOutcome<T> = { ok: true; value: T } | { ok: false; detail: string };

/**
 * The stored form of a channel identity. Keyed, not merely hashed — see the note above.
 */
export function identityHash(kind: string, value: string): Buffer {
  return createHmac('sha256', required('IDENTITY_PEPPER')).update(`${kind}:${value}`, 'utf8').digest();
}

/**
 * Find or create the contact for a PSID on a channel.
 *
 * Keyed by CHANNEL, not by provider: a PSID is Page-scoped and an IGSID is
 * account-scoped, so two tenants can legitimately see the same numeric id and it means
 * different people. `(tenant_id, channel_id, external_id)` is the unique index, and the
 * upsert leans on it rather than reading first — two workers racing a first message would
 * otherwise both read "absent" and both insert.
 */
export async function ensureContact(
  db: SupabaseClient,
  input: { tenantId: string; channelId: string; externalId: string; displayName?: string | null; now: Date },
): Promise<PersistOutcome<{ contactId: string; personId: string | null }>> {
  if (input.externalId === '') return { ok: false, detail: 'refusing to create a contact with no external id' };

  const { data, error } = await db
    .from('contacts')
    .upsert(
      {
        tenant_id: input.tenantId,
        channel_id: input.channelId,
        external_id: input.externalId,
        ...(input.displayName != null ? { display_name: nfc(input.displayName) } : {}),
        last_seen_at: input.now.toISOString(),
      },
      { onConflict: 'tenant_id,channel_id,external_id' },
    )
    .select('id, person_id')
    .maybeSingle();

  if (error) return { ok: false, detail: `contacts upsert failed: ${error.message}` };
  if (data === null) return { ok: false, detail: 'contacts upsert returned no row' };

  const row = data as Record<string, unknown>;
  const personId = row['person_id'];
  return {
    ok: true,
    value: { contactId: String(row['id']), personId: typeof personId === 'string' ? personId : null },
  };
}

/**
 * Attach a person to a contact that has none, recording the hashed identity.
 *
 * Separate from `ensureContact` because a contact is useful without one — the person layer
 * exists for consent, which is keyed by person rather than by contact, and a first message
 * should not fail because the person layer had a bad day.
 */
export async function ensurePerson(
  db: SupabaseClient,
  input: { tenantId: string; contactId: string; kind: 'psid' | 'igsid'; externalId: string },
): Promise<PersistOutcome<string>> {
  const { data: person, error: personErr } = await db
    .from('persons')
    .insert({ tenant_id: input.tenantId })
    .select('id')
    .maybeSingle();
  if (personErr) return { ok: false, detail: `persons insert failed: ${personErr.message}` };
  if (person === null) return { ok: false, detail: 'persons insert returned no row' };
  const personId = String((person as Record<string, unknown>)['id']);

  const { error: identityErr } = await db.from('person_identities').upsert(
    {
      tenant_id: input.tenantId,
      person_id: personId,
      kind: input.kind,
      value_hash: identityHash(input.kind, input.externalId),
    },
    { onConflict: 'tenant_id,kind,value_hash', ignoreDuplicates: true },
  );
  if (identityErr) return { ok: false, detail: `person_identities upsert failed: ${identityErr.message}` };

  const { error: linkErr } = await db
    .from('contacts')
    .update({ person_id: personId })
    .eq('tenant_id', input.tenantId)
    .eq('id', input.contactId)
    .is('person_id', null);   // CAS: never steal a contact that already has one.
  if (linkErr) return { ok: false, detail: `contact link failed: ${linkErr.message}` };

  return { ok: true, value: personId };
}

/**
 * The conversation this message belongs to: the most recent open one within the idle
 * window, or a new one.
 *
 * A conversation is not closed by this function. Closing is a separate sweep — a worker
 * that closed the previous conversation before opening a new one would do it on the
 * customer's latency budget, for no benefit to them.
 */
export async function openConversation(
  db: SupabaseClient,
  input: { tenantId: string; contactId: string; channelId: string; now: Date; idleMs?: number },
): Promise<PersistOutcome<{ conversationId: string; created: boolean }>> {
  const cutoff = new Date(input.now.getTime() - (input.idleMs ?? CONVERSATION_IDLE_MS)).toISOString();

  const { data: existing, error: readErr } = await db
    .from('conversations')
    .select('id')
    .eq('tenant_id', input.tenantId)
    .eq('contact_id', input.contactId)
    .in('state', OPEN_STATES)
    .gte('last_message_at', cutoff)
    .order('last_message_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (readErr) return { ok: false, detail: `conversations unreadable: ${readErr.message}` };

  if (existing !== null) {
    const id = String((existing as Record<string, unknown>)['id']);
    const { error } = await db
      .from('conversations')
      .update({ last_message_at: input.now.toISOString() })
      .eq('tenant_id', input.tenantId)
      .eq('id', id);
    if (error) return { ok: false, detail: `conversation touch failed: ${error.message}` };
    return { ok: true, value: { conversationId: id, created: false } };
  }

  const { data: fresh, error: insertErr } = await db
    .from('conversations')
    .insert({
      tenant_id: input.tenantId,
      contact_id: input.contactId,
      channel_id: input.channelId,
      state: 'active',
      last_message_at: input.now.toISOString(),
    })
    .select('id')
    .maybeSingle();
  if (insertErr) return { ok: false, detail: `conversations insert failed: ${insertErr.message}` };
  if (fresh === null) return { ok: false, detail: 'conversations insert returned no row' };

  return { ok: true, value: { conversationId: String((fresh as Record<string, unknown>)['id']), created: true } };
}

/**
 * Store the customer's message, exactly once per `(tenant, conversation, external_id)`.
 *
 * A redelivery finds the row already there and says so, rather than inserting a second
 * copy that would then appear twice in the history the model is shown.
 */
export async function recordInbound(
  db: SupabaseClient,
  input: { tenantId: string; conversationId: string; externalId: string; body: string; now: Date },
): Promise<PersistOutcome<{ messageId: string; duplicate: boolean }>> {
  const body = nfc(input.body);
  // `redacted_or_present`: a retained message either has a body or has been redacted,
  // never silently empty. An empty inbound message is a delivery we cannot answer.
  if (body.trim() === '') return { ok: false, detail: 'refusing to store an empty inbound message' };

  const { data, error } = await db
    .from('messages')
    .insert({
      tenant_id: input.tenantId,
      conversation_id: input.conversationId,
      direction: 'inbound',
      external_id: input.externalId === '' ? null : input.externalId,
      body,
      at: input.now.toISOString(),
    })
    .select('id')
    .maybeSingle();

  if (error === null && data !== null) {
    return { ok: true, value: { messageId: String((data as Record<string, unknown>)['id']), duplicate: false } };
  }

  const code = (error as { code?: string } | null)?.code;
  if (code !== '23505') {
    return { ok: false, detail: `messages insert failed: ${error?.message ?? 'insert returned no row'}` };
  }

  const { data: existing, error: readErr } = await db
    .from('messages')
    .select('id')
    .eq('tenant_id', input.tenantId)
    .eq('conversation_id', input.conversationId)
    .eq('external_id', input.externalId)
    .maybeSingle();
  if (readErr) return { ok: false, detail: `existing message unreadable: ${readErr.message}` };
  if (existing === null) return { ok: false, detail: 'unique violation but no row found' };

  return { ok: true, value: { messageId: String((existing as Record<string, unknown>)['id']), duplicate: true } };
}

export type Turn = { role: 'user' | 'assistant'; content: string };

/**
 * The last `limit` turns, oldest first, ready for `messages[]`.
 *
 * **A read failure returns an error, never an empty history.** The ancestor's
 * `getHistory` returns `null` when Redis is unreachable and `[]` only when it genuinely
 * answered "no turns", and `messengerProcess.js:59` carries that distinction — without it
 * a hiccup makes the bot greet an existing customer from scratch. The same rule holds
 * here, and it is why this returns an outcome rather than an array.
 *
 * Redacted messages are skipped rather than sent as empty strings: a retention purge must
 * not put a blank turn in front of the model.
 */
/**
 * Outbound states whose body the customer could plausibly have in front of them.
 *
 * `sent` is unambiguous. `draft` is included because the mirror phase produces nothing
 * else: excluding it would give every shadow tenant the all-user transcript this function
 * exists to prevent, on exactly the conversations being run to measure quality. `failed`,
 * `refused` and `indeterminate` are excluded — a reply nobody read is not something the
 * assistant said, and replaying it would have the model build on a turn the customer never
 * saw.
 */
const HISTORY_OUTBOUND_STATES = ['sent', 'draft'] as const;

export async function readHistory(
  db: SupabaseClient,
  input: { tenantId: string; conversationId: string; limit: number },
): Promise<PersistOutcome<Turn[]>> {
  // TWO tables, because the conversation is stored in two halves and this function is the
  // only place that has ever needed both (D-111).
  //
  // `messages` holds the customer; the assistant's replies live in `outbound_messages` and
  // were NEVER mirrored back. The `direction === 'outbound'` branch below has been dead
  // code since `0001` — measured 2026-09-21 against the live project: 194 inbound rows and
  // zero outbound, platform-wide. So every multi-turn conversation reached the model as N
  // consecutive USER turns with no assistant turn between them, and the model did the only
  // sensible thing with a transcript of ten unanswered questions: it answered all ten,
  // every turn, growing the reply each time and re-greeting because it could not see that
  // it had greeted. It is D-064's rule applied to a VALUE rather than a column — computed,
  // stored elsewhere, and never carried to the one reader that needed it (D-083's lesson).
  //
  // The reads are issued together: they are independent, and this sits on the reply path
  // where a second serial round trip is latency a customer feels.
  const [inbound, outbound] = await Promise.all([
    db.from('messages')
      .select('direction, body, at')
      .eq('tenant_id', input.tenantId)
      .eq('conversation_id', input.conversationId)
      .order('at', { ascending: false })
      .limit(input.limit),
    db.from('outbound_messages')
      .select('body, created_at, state')
      .eq('tenant_id', input.tenantId)
      .eq('conversation_id', input.conversationId)
      .in('state', [...HISTORY_OUTBOUND_STATES])
      .order('created_at', { ascending: false })
      .limit(input.limit),
  ]);

  if (inbound.error) return { ok: false, detail: `history unreadable: ${inbound.error.message}` };
  // Fails closed for the same reason the inbound half does: an empty assistant side is
  // indistinguishable from the bug this fixes, and a hiccup must not silently restore it.
  if (outbound.error) return { ok: false, detail: `history unreadable: ${outbound.error.message}` };

  type Stamped = { at: number; turn: Turn };
  const stamped: Stamped[] = [];

  const push = (body: unknown, whenRaw: unknown, role: 'user' | 'assistant'): void => {
    if (typeof body !== 'string' || body.trim() === '') return;
    const at = typeof whenRaw === 'string' ? new Date(whenRaw).getTime() : Number.NaN;
    // A turn with no readable timestamp cannot be ordered, and a reply placed in the wrong
    // place is worse than one left out: it would show the assistant answering a question
    // the customer had not asked yet.
    if (Number.isNaN(at)) return;
    stamped.push({ at, turn: { role, content: nfc(body) } });
  };

  for (const raw of Array.isArray(inbound.data) ? inbound.data : []) {
    const r = raw as Record<string, unknown>;
    push(r['body'], r['at'], r['direction'] === 'outbound' ? 'assistant' : 'user');
  }
  for (const raw of Array.isArray(outbound.data) ? outbound.data : []) {
    const r = raw as Record<string, unknown>;
    push(r['body'], r['created_at'], 'assistant');
  }

  // Interleaved by time, then trimmed from the END so the newest turns survive — taking
  // the first N of a merged list would feed the model the oldest half of the conversation.
  stamped.sort((a, b) => a.at - b.at);
  return { ok: true, value: stamped.slice(-input.limit).map((s) => s.turn) };
}

/**
 * Record what answered this customer message, on the customer's own row.
 *
 * `messages.answered_by`, `revision_id` and `prompt_hash` have existed since `0001` and
 * were written by NOTHING until 2026-09-14. `reception/deps.ts` had a literal
 * `void answeredBy;` — the value was computed, passed across the seam, and thrown away —
 * and the revision and prompt hash never left `ReceptionContext` at all.
 *
 * What that cost, concretely, on the day it was found: Matrix's mirror was drafting against
 * real customers, and a republish was days away. Two drafts either side of a config change
 * would have been indistinguishable in the table, so the fourteen days could not answer
 * "did that edit help" — which is the entire question the mirror exists to answer.
 *
 * ## The INBOUND row, not the reply
 *
 * The reply lives in `outbound_messages` and is keyed on the inbound message id. These
 * columns are on `messages` because the question is "what answered THIS customer", and the
 * customer's message is the row a reader has in front of them — from the Quality layer,
 * from a conversation, from a complaint. A reply that was refused into a handoff has an
 * `outbound_messages` row too, and it should say `canned`, which it does.
 *
 * ## Best-effort, and it must stay that way
 *
 * The reply already exists when this runs. A trace that cannot be written is evidence lost,
 * which is bad; refusing the customer's answer over it would be worse, and a retry would
 * re-drive an event whose reply is already drafted. So this returns its failure and the
 * caller logs it — the same posture `flagQuality` takes, for the same reason.
 */
export async function traceAnswer(
  db: SupabaseClient,
  input: {
    tenantId: string;
    /** The inbound `messages.id` from `recordInbound`. */
    messageId: string;
    answeredBy: AnsweredBy;
    revisionId: string;
    /** The snapshot's `content_hash`: which compiled prefix produced this answer. */
    promptHash: string;
  },
): Promise<{ ok: boolean; detail?: string }> {
  const { error } = await db
    .from('messages')
    .update({
      answered_by: input.answeredBy,
      revision_id: input.revisionId,
      prompt_hash: input.promptHash,
    })
    .eq('id', input.messageId)
    // The tenant is in the predicate as well as the id. `messages` has `unique (tenant_id,
    // id)` and the id alone would be enough, but every write on this path is scoped to the
    // tenant it belongs to and an exception would be the one nobody re-reads.
    .eq('tenant_id', input.tenantId);
  return error ? { ok: false, detail: error.message } : { ok: true };
}
