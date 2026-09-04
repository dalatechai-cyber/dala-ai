/**
 * Meta's Data Deletion Request, recorded (§2.4F, §10.5).
 *
 * ## The thing that makes this hard, stated once
 *
 * **Meta's callback sends an app-scoped id (ASID). Every id this database holds for a
 * customer is a page-scoped id (PSID) or an IGSID.** They are different namespaces for
 * the same human: Facebook issues an ASID when somebody uses Facebook Login with an app,
 * and a PSID when somebody messages a Page. A bot's customers have only ever done the
 * second, so their ASID has never appeared in any webhook we have received.
 *
 * The consequence is the whole design of this module. `select * from contacts where
 * external_id = <asid>` returns nothing — not "this person has no data", but "you asked
 * the wrong question". Written the obvious way, this endpoint would return a confirmation
 * code for a deletion that never happened and could never happen, and nothing anywhere
 * would say so. That is a privacy promise broken silently, which is worse than one
 * refused loudly.
 *
 * So: **a request is RECORDED, and recording is not deleting.** The row says which
 * namespace the id is in (`id_kind = 'asid'`), the status says how far it got
 * (`received`, never `completed`), and an operator alert says a request is outstanding.
 * Bridging the namespaces needs Meta's ID Matching API (`GET /{id}/ids_for_pages`), which
 * needs a Business Manager containing the app and every Page — and neither the app nor the
 * Business Manager exists yet. Building that resolver against an unverified endpoint,
 * untestable, on the one path where a wrong answer is a legal exposure, would be worse
 * than not building it. `docs/STATUS.md` carries what it needs.
 *
 * ## The confirmation code is a credential
 *
 * It is the only thing the person is given and the only key to their status page, which
 * is public and unauthenticated. So it is 120 bits of `randomBytes`, not a sequence, not
 * a hash of the id, and not the row's uuid — a code derived from the ASID would let
 * anybody holding an ASID read that person's request.
 */
import { randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * 32 unambiguous characters. `I`, `O`, `0` and `1` are absent because this code is read
 * off a screen and typed into another one, sometimes over a phone.
 *
 * 256 / 32 is exactly 8, so masking a random byte to 5 bits is uniform. A modulo over a
 * non-power-of-two alphabet would not be, and biased entropy in a credential is the kind
 * of defect that is invisible until somebody looks for it.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 24; // 24 × 5 bits = 120 bits.

export function newConfirmationCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let out = '';
  for (const b of bytes) out += ALPHABET[b & 31];
  return out;
}

/** Shape check only — a code is a lookup key from an untrusted query string. */
export function isConfirmationCode(value: unknown): value is string {
  // ascii-safe: the confirmation code's own alphabet, ASCII by construction (see ALPHABET).
  return typeof value === 'string' && value.length === CODE_LENGTH && /^[A-Z2-9]+$/.test(value); // ascii-safe: as above
}

export type ErasureIdKind = 'asid' | 'psid' | 'igsid';

export type RecordErasureInput = {
  provider: string;
  /** The id exactly as the provider gave it. */
  externalId: string;
  idKind: ErasureIdKind;
  /** Which configured app secret verified the request. An ASID is app-scoped. */
  appSlug: string;
  issuedAt: Date | null;
};

export type RecordErasureOutcome =
  /** Written now. */
  | { ok: true; created: true; code: string }
  /** A request for this person was already open — a redelivery. Their existing code. */
  | { ok: true; created: false; code: string }
  | { ok: false; detail: string };

/**
 * Write the request, exactly once per open `(app_slug, external_id)`.
 *
 * Same idiom as `outbound/claim.ts`: the uniqueness is a partial unique index and the
 * duplicate is discovered by losing the insert, not by a read-then-write that two
 * concurrent redeliveries would both pass. A duplicate here is not an error — it is Meta
 * re-sending, and the right answer is the code we already issued rather than a second one
 * for the same request.
 */
export async function recordErasureRequest(
  db: SupabaseClient,
  input: RecordErasureInput,
): Promise<RecordErasureOutcome> {
  if (input.externalId.trim() === '' || input.appSlug.trim() === '') {
    return { ok: false, detail: 'refusing to record an erasure request with no id or no app' };
  }
  const code = newConfirmationCode();

  const { data, error } = await db
    .from('contact_erasure_requests')
    .insert({
      // NULL, and deliberately: the callback is app-scoped, so at this moment we do not
      // know whose customer this is. See 0008's note.
      tenant_id: null,
      source: 'meta_callback',
      provider: input.provider,
      external_id: input.externalId,
      id_kind: input.idKind,
      app_slug: input.appSlug,
      issued_at: input.issuedAt === null ? null : input.issuedAt.toISOString(),
      status: 'received',
      confirmation_code: code,
    })
    .select('confirmation_code')
    .maybeSingle();

  if (error === null && data !== null) {
    return { ok: true, created: true, code: String((data as Record<string, unknown>)['confirmation_code']) };
  }

  const pgCode = (error as { code?: string } | null)?.code;
  if (pgCode !== '23505') {
    return { ok: false, detail: `erasure request insert failed: ${error?.message ?? 'insert returned no row'}` };
  }

  const { data: existing, error: readErr } = await db
    .from('contact_erasure_requests')
    .select('confirmation_code')
    .eq('app_slug', input.appSlug)
    .eq('external_id', input.externalId)
    .eq('source', 'meta_callback')
    .is('completed_at', null)
    .maybeSingle();

  if (readErr) return { ok: false, detail: `existing erasure request unreadable: ${readErr.message}` };
  if (existing === null) {
    // The index said it exists and the read says it does not. The other possibility is a
    // confirmation-code collision, which at 120 bits is not a thing that happens. Either
    // way, refuse rather than hand out a code for a row we cannot point at.
    return { ok: false, detail: 'unique violation but no open request found: refusing to issue a code' };
  }
  return { ok: true, created: false, code: String((existing as Record<string, unknown>)['confirmation_code']) };
}

export type ErasureStatus = 'received' | 'matched' | 'no_match' | 'completed' | 'failed';

export type ErasureStatusOutcome =
  | { outcome: 'found'; status: ErasureStatus; requestedAt: Date | null; completedAt: Date | null }
  | { outcome: 'not_found' }
  | { outcome: 'unavailable'; detail: string };

/**
 * The status page's only query.
 *
 * Returns dates and a state and nothing else — no id, no tenant, no name. The page is
 * public and its key is a code that could be shoulder-surfed, so what it can leak is
 * bounded to what the holder already knows: that they asked, and when.
 */
export async function readErasureStatus(db: SupabaseClient, code: string): Promise<ErasureStatusOutcome> {
  if (!isConfirmationCode(code)) return { outcome: 'not_found' };

  const { data, error } = await db
    .from('contact_erasure_requests')
    .select('status, requested_at, completed_at')
    .eq('confirmation_code', code)
    .maybeSingle();

  if (error) return { outcome: 'unavailable', detail: `erasure request unreadable: ${error.message}` };
  if (data === null) return { outcome: 'not_found' };

  const row = data as Record<string, unknown>;
  const date = (v: unknown): Date | null => {
    if (typeof v !== 'string') return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  return {
    outcome: 'found',
    status: String(row['status']) as ErasureStatus,
    requestedAt: date(row['requested_at']),
    completedAt: date(row['completed_at']),
  };
}
