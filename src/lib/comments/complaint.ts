/**
 * A complaint on the salon's wall, told to the founder at once (D-122).
 *
 * Founder, 2026-09-25: *"Complaints and angry comments: no reply, plus a Telegram alert to
 * me with the link."* The `comment_escalated` flag row was already the durable record
 * (D-085); nobody reads a table at the moment a customer is angry in public, so this is the
 * tap on the shoulder.
 *
 * `once` per comment: a redelivery of the same entry re-runs the classifier, and the
 * founder should hear about one complaint once. The comment's own words are in the body —
 * it is already public on the Page, and "someone complained" without saying what is a
 * message the founder has to open Facebook to understand. Truncated, so a paragraph of
 * anger does not become a wall of Telegram.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { raiseAlert, type AlertOutcome } from '../alerts/alert.ts';

export const COMPLAINT_ALERT_KIND = 'comment.complaint';
const MAX_QUOTED_CHARS = 280;

export function complaintAlertBody(input: { tenantName: string; text: string; link: string }): string {
  const chars = Array.from(input.text.trim());
  const quoted = chars.length > MAX_QUOTED_CHARS ? `${chars.slice(0, MAX_QUOTED_CHARS).join('')}…` : chars.join('');
  return [
    `Гомдол / complaint comment — ${input.tenantName}`,
    `«${quoted}»`,
    'No reply was posted. Answer it yourself:',
    input.link,
  ].join('\n');
}

export async function raiseCommentComplaint(
  db: SupabaseClient,
  input: { tenantId: string; commentId: string; text: string; link: string },
): Promise<AlertOutcome> {
  // The tenant's name, not its id: the founder reads this on a phone. Unreadable is not a
  // reason to stay silent about a complaint, so it falls back to the id.
  const { data } = await db.from('tenants').select('display_name').eq('id', input.tenantId).maybeSingle();
  const name = typeof (data as Record<string, unknown> | null)?.['display_name'] === 'string'
    ? String((data as Record<string, unknown>)['display_name'])
    : input.tenantId;
  return raiseAlert(db, {
    tenantId: input.tenantId,
    severity: 'warn',
    kind: COMPLAINT_ALERT_KIND,
    dedupKey: `comment:${input.commentId}`,
    body: complaintAlertBody({ tenantName: name, text: input.text, link: input.link }),
    route: 'now',
    repeat: 'once',
  });
}
