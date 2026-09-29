/**
 * A customer who sends a photo, a video or a link to one is handed to a person (founder,
 * 2026-09-27).
 *
 * On Tara Salon's Page (the matrix-eco-salon tenant), a real customer shared a Facebook reel of a hair colour and asked «Ene budalt hed
 * boloh be?». The bot cannot see a reel. It said so («энэ линкийг би харах боломжгүй») and
 * asked her to describe the colour. The salon's staff member could see it and answer in a
 * minute. The founder's rule: when a customer sends a link, photo or video and asks about it,
 * the bot says a staff member will look and reply, hands the conversation to the staff, and
 * the founder gets a Telegram alert.
 *
 * ## Inert until the tenant has the line
 *
 * The reply is the tenant's reviewed `handover_notice` row (a kind registered by `0033`, and
 * already one of `MODEL_INVISIBLE_KINDS`, so adding the row moves no `canned_hash` and needs
 * no republish). A tenant without it keeps today's behaviour: a captioned photo gets the
 * image line, a link goes to the model. Nothing here invents a sentence.
 *
 * ## "Hands the conversation to staff"
 *
 * After the notice is SENT, the thread becomes `human` with source `handover`, which
 * `humanHoldsThread` holds for the tenant's takeover cooldown, exactly as a staff reply does
 * (founder, 2026-09-27: the 30 minutes stay as they are). So the customer's next message
 * («Ene budalt hed boloh be?», when the link came alone) is left to the person. After the
 * send and not before, because the pre-send check reads a `human` thread set after the
 * customer's message as "a person replied" and would drop the notice itself.
 *
 * ## A photo or a video sent ALONE (founder, 2026-09-27: "never silence")
 *
 * A message with no words never reaches Reception: `meta/extract.ts` skips it as `no_text`.
 * `planMediaAlone` picks those skips (a photo, a video or a shared reel or post, never a
 * sticker, D-070) and the worker serves the same notice and the same hand-off to them,
 * sending it itself. Before this, a video alone was only recorded as dropped, and a photo
 * alone got the image line DRAFTED and never sent: nothing claims those drafts (Tara, 11
 * rows in `draft`, the newest 2026-09-25). A tenant without the notice keeps that older path.
 *
 * ## A shared reel or post is an attachment, not a word
 *
 * A reel shared with Messenger's share button arrives as an attachment of type `reel`
 * (`payload.url`, `payload.reel_video_id`), sometimes with no text at all: Tara's Page,
 * `webhook_events` 142 and 144 (2026-09-18, text-less) and 979 (2026-09-27, the link as
 * text). Before this, only 979 counted as media, and only because its text was a link; the
 * two text-less ones were skipped as `no_text` and never answered. `MEDIA_ATTACHMENT_KINDS`
 * is the attachment side of the rule, so it holds whatever the customer typed. Instagram's
 * kinds for a shared reel or post (`ig_reel`, `reel`, `share`) are Meta's documented names;
 * no Instagram customer has sent one yet, so those three are unproven on the live channel.
 * `story_mention` is left out on purpose: it is a customer tagging the business in their
 * own story, not a question about a picture.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { raiseAlert, type AlertOutcome } from '../alerts/alert.ts';
import { extractUrls } from '../mn/extract.ts';
import type { SkippedEvent } from '../meta/extract.ts';

/**
 * Attachment kinds (Meta's `attachments[].type`, verbatim) that are a video, a reel or a
 * shared post the bot cannot open. A photo is not listed: it goes through `sentPhoto`, which
 * already excludes a sticker declaring `image` (D-070).
 */
export const MEDIA_ATTACHMENT_KINDS: readonly string[] = ['video', 'reel', 'ig_reel', 'share'];

function hasMediaAttachment(attachments: readonly string[]): boolean {
  return attachments.some((k) => MEDIA_ATTACHMENT_KINDS.includes(k));
}

/** The reviewed line this path serves. */
export const MEDIA_HANDOFF_KIND = 'handover_notice';
export const MEDIA_HANDOFF_ALERT_KIND = 'conversation.media_handoff';

/**
 * Links that are a photo or a video the bot cannot open, as host → the paths that carry
 * media. A profile or channel page (the tenant's own Instagram, a YouTube channel) is not a
 * picture of anything, so only these paths count. `null` means every path on that host is
 * media (short links that only ever point at one).
 */
const MEDIA_PATHS: ReadonlyArray<readonly [string, readonly string[] | null]> = [
  ['fb.watch', null],
  ['facebook.com', ['/share/r/', '/share/v/', '/share/p/', '/reel', '/reels', '/watch', '/videos/', '/photo', '/photos/', '/story', '/stories/']],
  ['fb.com', ['/share/r/', '/share/v/', '/share/p/', '/reel', '/reels', '/watch', '/videos/', '/photo', '/photos/', '/story', '/stories/']],
  ['instagram.com', ['/p/', '/reel/', '/reels/', '/tv/', '/stories/']],
  ['instagr.am', ['/p/', '/reel/']],
  ['vm.tiktok.com', null],
  ['vt.tiktok.com', null],
  ['tiktok.com', ['/@', '/t/']],
  ['youtu.be', null],
  ['youtube.com', ['/watch', '/shorts/', '/live/']],
  ['pin.it', null],
  ['pinterest.com', ['/pin/']],
];

function hostMatches(host: string, base: string): boolean {
  return host === base || host.endsWith(`.${base}`);
}

/** The links in `text` that point at a photo or a video. */
export function mediaLinksIn(text: string): string[] {
  return extractUrls(text).filter((raw) => {
    let u: URL;
    try {
      u = new URL(/^https?:\/\//iu.test(raw) ? raw : `https://${raw}`);
    } catch {
      return false;
    }
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    // Most specific host first: `vm.tiktok.com` before `tiktok.com`.
    const entry = MEDIA_PATHS.find(([base]) => hostMatches(host, base));
    if (entry === undefined) return false;
    const paths = entry[1];
    if (paths === null) return true;
    // A TikTok profile is `/@name`; its videos are `/@name/video/…`.
    if (hostMatches(host, 'tiktok.com') && path.startsWith('/@')) return path.includes('/video/') || path.includes('/photo/');
    return paths.some((p) => path.startsWith(p));
  });
}

/**
 * Did the customer send something the bot cannot see? A photo (never a sticker: the caller's
 * `sentPhoto` already excludes those, D-070), a video, a shared reel or post, or a link to one.
 */
export function isMediaMessage(input: { text: string; attachments: readonly string[]; sentPhoto: boolean }): boolean {
  return input.sentPhoto || hasMediaAttachment(input.attachments) || mediaLinksIn(input.text).length > 0;
}

/**
 * The Telegram text. Ids and the media links only, never what the customer wrote: the chat
 * is shared (CLAUDE.md), alerts are never purged, and a person opens the conversation to
 * read it anyway ("ids, never message text", `health/stranded.ts`).
 */
export function mediaHandoffAlertBody(input: { tenantName: string; links: readonly string[]; conversationId: string }): string {
  const what = input.links.length === 0 ? 'an attached photo or video' : input.links.slice(0, 3).join(' ');
  return `📎 ${input.tenantName}: a customer sent a photo, video or link (${what})\n`
    + 'They were told a staff member will look and reply. The bot stays silent in this conversation for the takeover window.\n'
    + `Conversation ${input.conversationId}`;
}

/**
 * One alert per handed-off message, unless the tenant turned the alert off
 * (`tenants.media_handoff_alert`, D-153). Off changes nothing but the alert: the notice was
 * already sent and the thread is already the staff's. An unreadable setting alerts, because
 * a silent failure here hides a hand-off from the one person who can act on it.
 */
export async function raiseMediaHandoff(
  db: SupabaseClient,
  input: { tenantId: string; conversationId: string; externalId: string; text: string },
): Promise<AlertOutcome | { outcome: 'disabled' }> {
  const { data } = await db.from('tenants').select('display_name, media_handoff_alert').eq('id', input.tenantId).maybeSingle();
  const row = data as Record<string, unknown> | null;
  if (row?.['media_handoff_alert'] === false) return { outcome: 'disabled' };
  const name = typeof row?.['display_name'] === 'string' ? String(row['display_name']) : input.tenantId;
  return raiseAlert(db, {
    tenantId: input.tenantId,
    severity: 'warn',
    kind: MEDIA_HANDOFF_ALERT_KIND,
    dedupKey: `media:${input.conversationId}:${input.externalId}`,
    body: mediaHandoffAlertBody({ tenantName: name, links: mediaLinksIn(input.text), conversationId: input.conversationId }),
    route: 'now',
    repeat: 'once',
  });
}

export type PlannedMediaAlone = { idx: number; senderId: string; externalId: string | null };

/**
 * The skipped messages that are a photo, a video or a shared reel or post with no words. At
 * most one per sender per entry (three photos in one batch are one question). A sticker is never one: the
 * discriminator is `stickerIds`, never the declared `type` (D-070).
 */
export function planMediaAlone(skipped: readonly SkippedEvent[]): PlannedMediaAlone[] {
  const seen = new Set<string>();
  const out: PlannedMediaAlone[] = [];
  for (const s of skipped) {
    if (s.reason !== 'no_text') continue;
    if (!s.attachments.includes('image') && !hasMediaAttachment(s.attachments)) continue;
    if (s.stickerIds.length > 0) continue;
    if (s.senderId === null || s.senderId === '' || seen.has(s.senderId)) continue;
    seen.add(s.senderId);
    out.push({ idx: s.idx, senderId: s.senderId, externalId: s.externalId });
  }
  return out;
}

/** `media:{event}:{idx}`: stable across a redelivery, so a retry re-sends, never re-answers. */
export function mediaAloneDedupKey(eventId: number | string, idx: number): string {
  return `media:${eventId}:${idx}`;
}

/** The tenant's notice with its review state; the caller decides what missing or unreviewed means. */
export async function readHandoverNotice(
  db: SupabaseClient,
  input: { tenantId: string; locale: string },
): Promise<{ ok: true; line: { body: string; reviewed: boolean } | null } | { ok: false; detail: string }> {
  const { data, error } = await db
    .from('canned_responses')
    .select('body, reviewed_at')
    .eq('tenant_id', input.tenantId)
    .eq('kind', MEDIA_HANDOFF_KIND)
    .eq('locale', input.locale)
    .maybeSingle();
  if (error) return { ok: false, detail: `canned_responses unreadable: ${error.message}` };
  if (data === null) return { ok: true, line: null };
  const row = data as Record<string, unknown>;
  return { ok: true, line: { body: String(row['body'] ?? ''), reviewed: row['reviewed_at'] !== null && row['reviewed_at'] !== undefined } };
}
