/**
 * The Messenger "like" (the thumbs-up), as a message the tenant's fixed replies can answer.
 *
 * Founder, 2026-10-01 (D-168): a like as the first message, or after a long silence, gets the
 * tenant's welcome reply; a like right after Дали's own answer is an «ок / за» and gets that
 * fixed reply; the same like is never answered twice; no model is ever called for one.
 *
 * Until then every sticker was skipped (`no_text`, D-070). A like is still keyed on the
 * `sticker_id` in the PAYLOAD, never on `type` (`attachmentKinds`): Meta declares the same
 * thumbs-up once as an `image` and once as a `sticker`. The three ids are its three sizes
 * (tap, hold, hold longer). Every other sticker stays skipped.
 *
 * The like becomes the text `LIKE_TEXT`. Text, because the reply path, the history and the
 * reply cases all speak text, and a `messages` row must have a body. The text keeps the
 * thumbs-up for whoever reads the transcript, and the word `like` for the matchers: every
 * matcher drops symbols and emoji first, so «👍» alone reduces to nothing and matches no row.
 * A tenant answers a like by listing `like` as a stem of a `whole_message` row.
 */
export const LIKE_STICKER_IDS: readonly string[] = ['369239263222822', '369239343222814', '369239383222810'];

export const LIKE_TEXT = '👍 (like)';

/** An attachment-only message that is a like and nothing else. */
export function isLikeSticker(kinds: readonly string[], stickerIds: readonly string[]): boolean {
  return kinds.length === 1 && kinds[0] === 'sticker'
    && stickerIds.length > 0 && stickerIds.every((id) => LIKE_STICKER_IDS.includes(id));
}

/** A customer turn that is a like. */
export function isLike(text: string): boolean {
  return text.trim() === LIKE_TEXT;
}
