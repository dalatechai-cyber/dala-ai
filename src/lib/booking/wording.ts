/**
 * Every sentence the booking flow sends, and how it is filled.
 *
 * Each is a signed platform block (`prompt_blocks`, scope `platform`, layer null), exactly as
 * billing's are (`billing/templates.ts`). There is no fallback string anywhere: a block that is
 * missing or unsigned keeps the WHOLE flow off for every tenant (`missingBlocks`), because a
 * half-worded booking is worse than the website link a customer gets today. The drafts are in
 * `prompt/drafts/booking/`; deployed code never reads a draft. Tests and the end-to-end check
 * read the drafts through `draftWording`, which nothing in `src/` outside tests calls.
 *
 * Placeholders are checked both ways, as billing's are: a block that uses a name it may not, or
 * leaves out one it must carry, refuses to render.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

type Spec = { required: readonly string[]; optional: readonly string[] };
const NONE: Spec = { required: [], optional: [] };

export const BOOKING_BLOCKS = {
  booking_ask_service_group: NONE,
  booking_ask_service: NONE,
  booking_ask_gender: NONE,
  booking_gender_female: NONE,
  booking_gender_male: NONE,
  booking_ask_stylist: NONE,
  booking_any_of_level: { required: ['level'], optional: [] },
  booking_ask_when: { required: ['service'], optional: [] },
  booking_when_again: NONE,
  booking_day_today: NONE,
  booking_day_tomorrow: NONE,
  booking_date: { required: ['month', 'day', 'weekday'], optional: [] },
  booking_ask_time: { required: ['date'], optional: [] },
  booking_time_free: { required: ['date', 'time'], optional: [] },
  booking_time_not_free: { required: ['date', 'time'], optional: [] },
  booking_day_full: { required: ['date'], optional: [] },
  booking_day_closed: { required: ['date'], optional: [] },
  booking_follow_up: NONE,
  booking_no_times: NONE,
  booking_ask_name: NONE,
  booking_ask_phone: NONE,
  booking_phone_invalid: NONE,
  booking_ask_agreement: { required: ['service', 'stylist', 'date', 'time', 'amount', 'agreement'], optional: [] },
  booking_agree: NONE,
  booking_cancel: NONE,
  booking_pay: { required: ['service', 'stylist', 'date', 'time', 'amount', 'minutes', 'pay_link'], optional: [] },
  booking_confirmed: { required: ['service', 'stylist', 'date', 'time', 'branch', 'address'], optional: [] },
  booking_expired: { required: ['minutes', 'date', 'time'], optional: [] },
  booking_choose_again: NONE,
  booking_slot_taken: NONE,
  booking_paid_unbooked: NONE,
  booking_paid_unbooked_offer: { required: ['date', 'time'], optional: [] },
  booking_excess: NONE,
  booking_cancelled: NONE,
  booking_unavailable: { required: ['booking_url'], optional: [] },
  booking_pick_from_list: NONE,
  booking_test_prefix: NONE,
  booking_page_title: NONE,
  booking_page_paid: NONE,
  booking_page_ended: NONE,
  // Signed already for the billing pay page; reused word for word on the deposit page.
  billing_page_qr_valid: { required: ['time'], optional: [] },
  billing_page_qr_expired: NONE,
  billing_page_qr_renew: NONE,
  billing_page_qr_wait: NONE,
  billing_page_scan: NONE,
  billing_page_banks: NONE,
  billing_page_amount: NONE,
  billing_pay_button: NONE,
} as const satisfies Record<string, Spec>;

export type BookingBlockKey = keyof typeof BOOKING_BLOCKS;
export const BOOKING_BLOCK_KEYS = Object.keys(BOOKING_BLOCKS) as BookingBlockKey[];

export type BookingWording = { source: 'signed' | 'draft'; blocks: ReadonlyMap<string, string> };

/** The signed blocks this flow reads. A read error is an error, never "none signed". */
export async function loadBookingWording(db: SupabaseClient): Promise<{ ok: true; wording: BookingWording } | { ok: false; detail: string }> {
  const { data, error } = await db
    .from('prompt_blocks')
    .select('block_key, body')
    .eq('scope', 'platform')
    .is('tenant_id', null)
    .not('reviewed_at', 'is', null)
    .in('block_key', BOOKING_BLOCK_KEYS);
  if (error) return { ok: false, detail: `prompt_blocks unreadable: ${error.message}` };
  const blocks = new Map<string, string>();
  for (const row of Array.isArray(data) ? data : []) {
    const r = row as Record<string, unknown>;
    const body = typeof r['body'] === 'string' ? r['body'].trim() : '';
    if (body !== '') blocks.set(String(r['block_key']), body.normalize('NFC'));
  }
  return { ok: true, wording: { source: 'signed', blocks } };
}

/** Blocks the flow needs and does not have. Non-empty: the flow stays off. */
export function missingBlocks(w: BookingWording): BookingBlockKey[] {
  return BOOKING_BLOCK_KEYS.filter((k) => !w.blocks.has(k) || !placeholdersFit(k, w.blocks.get(k) as string));
}

function placeholdersFit(key: BookingBlockKey, body: string): boolean {
  const spec: Spec = BOOKING_BLOCKS[key];
  const used = new Set([...body.matchAll(/\{([^{}\s]+)\}/gu)].map((m) => m[1] as string));
  for (const name of used) if (!spec.required.includes(name) && !spec.optional.includes(name)) return false;
  return spec.required.every((n) => used.has(n));
}

export class WordingError extends Error {}

/**
 * Render one block. Throws `WordingError` when it cannot: the caller has already checked
 * `missingBlocks` before the flow started, so a throw here is a bug, and a bug must not send
 * half a sentence.
 */
export function say(w: BookingWording, key: BookingBlockKey, values: Readonly<Record<string, string>> = {}): string {
  const body = w.blocks.get(key);
  if (body === undefined) throw new WordingError(`${key} is not signed`);
  if (!placeholdersFit(key, body)) throw new WordingError(`${key} does not carry exactly its placeholders`);
  return body.replace(/\{([^{}\s]+)\}/gu, (_, name: string) => {
    const v = values[name];
    if (v === undefined) throw new WordingError(`${key}: no value for {${name}}`);
    return v.normalize('NFC');
  }).normalize('NFC');
}
