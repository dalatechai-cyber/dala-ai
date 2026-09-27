/**
 * A customer who sends a photo, a video or a link to one is handed to a person (founder,
 * 2026-09-27).
 *
 * Tara, a real customer: she shared a Facebook reel of a hair colour and asked «Ene budalt hed
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
 * ## What does not reach this yet
 *
 * Only messages that reach Reception: a pasted link, and a photo or video sent WITH words.
 * A photo sent alone is answered by `inbound/imageReply.ts` before Reception runs, and a
 * video sent alone is recorded as dropped (`inbound/dropped.ts`); neither is handed off.
 * A reel shared with Messenger's share button may arrive as a share attachment, not a
 * link in the text; that is unverified.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { raiseAlert, type AlertOutcome } from '../alerts/alert.ts';
import { extractUrls } from '../mn/extract.ts';

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
 * `sentPhoto` already excludes those, D-070), a video, or a link to either.
 */
export function isMediaMessage(input: { text: string; attachments: readonly string[]; sentPhoto: boolean }): boolean {
  return input.sentPhoto || input.attachments.includes('video') || mediaLinksIn(input.text).length > 0;
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

/** One alert per handed-off message. Never throws: the notice is already sent. */
export async function raiseMediaHandoff(
  db: SupabaseClient,
  input: { tenantId: string; conversationId: string; externalId: string; text: string },
): Promise<AlertOutcome> {
  const { data } = await db.from('tenants').select('display_name').eq('id', input.tenantId).maybeSingle();
  const name = typeof (data as Record<string, unknown> | null)?.['display_name'] === 'string'
    ? String((data as Record<string, unknown>)['display_name'])
    : input.tenantId;
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
