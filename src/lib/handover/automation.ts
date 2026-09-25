/**
 * Is this text one of the Page's own Meta automations? (D-126 addendum, founder 2026-09-26.)
 *
 * Measured on DalaTech's Page: Meta Business Suite's comment-to-message automation sends its
 * DM with app id `263902037430900` — the same id a staff member's reply typed in the Page
 * inbox carries — and nothing else in the echo separates the two. Counted as a person, one
 * automated DM silences the bot for the whole cooldown, and the pre-send check drops a reply
 * already written. The tenant names its automations' texts (`tenant_channels.automation_texts`);
 * an echo or a Page comment with one of those texts is treated like our own send.
 *
 * Exact after normalisation — NFC, whitespace runs collapsed, `mn-MN` case fold — because a
 * looser match would let a person's short reply («Болноо») pass as an automation, which is
 * the bot talking over staff: the failure the rule it refines was built to stop.
 */
import { fold } from '../mn/text.ts';

export function automationKey(text: string): string {
  return fold(text).replace(/\s+/gu, ' ').trim();
}

export function isAutomationText(text: string | null | undefined, automationTexts: readonly string[]): boolean {
  if (typeof text !== 'string' || automationTexts.length === 0) return false;
  const key = automationKey(text);
  if (key === '') return false;
  return automationTexts.some((t) => automationKey(t) === key);
}
