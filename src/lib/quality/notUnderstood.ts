/**
 * Our reply saying it did not understand the customer — read over OUR text, never the
 * customer's, so the stem floor that protects customer matching does not apply: these are
 * whole inflected forms, not stems that could reach an unrelated word.
 *
 * Shared by the daily flaw report (`quality/flaws.ts`) and the salesperson (`sales/nextStep.ts`,
 * founder 2026-09-27: no offer after a reply where Tara did not understand the customer).
 */
import { containsStem } from '../mn/match.ts';
import { fold } from '../mn/text.ts';
import { chatKind } from '../mn/chat.ts';

export const NOT_UNDERSTOOD_STEMS: readonly string[] = ['ойлгосонгүй', 'ойлгоогүй', 'ойлгохгүй', 'тодруул', 'буруу ойлго'];

/**
 * A sentence that only invites the customer to ask. Measured on Tara, 2026-09-26 12:39: «хаая»
 * (a misspelt «хаяг») got «Сайн байна уу. Танд ямар нэг зүйл асуух зүйл байвал бидэнд
 * хэлээрэй, туслахад бэлэн байна.» — no answer, no admission, and a sales line after it would
 * have been the only content. Matched as folded phrases in OUR reply.
 */
export const INVITATION_PHRASES: readonly string[] = ['асуух зүйл', 'туслахад бэлэн', 'юугаар туслах'];

/** The reply says in words that it did not understand. */
export function saysNotUnderstood(reply: string): boolean {
  return NOT_UNDERSTOOD_STEMS.some((s) => containsStem(reply, s));
}

/**
 * The reply is nothing but a greeting and an invitation to ask: every sentence is a greeting or
 * carries an invitation phrase, and at least one invites. A real answer that ENDS with «Өөр асуух
 * зүйл байвал бичээрэй» keeps its answer sentence, so it is not this.
 */
export function onlyInvites(reply: string): boolean {
  const sentences = reply.split(/[.!?…\n]+/u).map((s) => s.trim()).filter((s) => s !== '');
  const invites = (s: string): boolean => INVITATION_PHRASES.some((p) => fold(s).includes(p));
  return sentences.some(invites) && sentences.every((s) => invites(s) || chatKind(s) === 'greeting');
}

/** Either: the reply did not understand the customer. */
export function replyNotUnderstood(reply: string): boolean {
  return saysNotUnderstood(reply) || onlyInvites(reply);
}
