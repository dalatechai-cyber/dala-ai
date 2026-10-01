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
import type { DeterministicRule } from '../gate/deterministic.ts';
import { wholeMessageMatches } from '../mn/match.ts';
import { isTenantConfirmed } from '../provenance.ts';

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

/**
 * Does the tenant answer a like at all: an enabled, confirmed `whole_message` row matches it,
 * on the history this like has (`historyEmpty`). A tenant with none treats a like as every
 * other sticker: nothing is opened, reserved or sent.
 */
export function likeRowFor(rules: readonly DeterministicRule[], historyEmpty: boolean | null): boolean {
  return rules.some((r) => r.enabled && isTenantConfirmed(r.provenance) && r.matchMode === 'whole_message'
    && r.placement !== 'append' && wholeMessageMatches(LIKE_TEXT, r.stems)
    && (historyEmpty === null || !r.requiresEmptyHistory || historyEmpty));
}

/**
 * Is a like owed an answer, on the turns before it? On an empty history, yes (the welcome).
 * Otherwise only right after Дали's own answer, and never when that answer was to a like: a
 * like before the answer it reacts to, after an unanswered message, or after an answered like
 * gets nothing (founder, 2026-10-01: never answer the same like twice).
 */
export function likeIsOwedReply(history: readonly { role: string; content: string }[]): boolean {
  if (history.length === 0) return true;
  const last = history[history.length - 1];
  const before = history.length >= 2 ? history[history.length - 2] : undefined;
  return last?.role === 'assistant' && !(before?.role === 'user' && isLike(before.content));
}
