/**
 * A photo and «how much?»: Дали asks which service and the hair length, then answers the price
 * from the rows; it hands the chat to a person only when it truly cannot (founder, 2026-10-04,
 * D-176, reversing D-152 for this case).
 *
 * ## What it replaces, and why
 *
 * Since D-151/D-152 a photo went to staff: the reviewed «a staff member will look» line, then
 * 30 minutes of silence from the bot. On Tara Яармаг, 2026-09-26 to 2026-10-03, that was 34
 * chats and 50 customer texts left unanswered, 26 of them never answered by a person
 * (`docs/reports/2026-10-03-tara-dali-quality.md` §1). Most were «how much is this colour?».
 * The price is in the rows; what the bot lacks is which service and how long the hair is, and
 * the customer can say both in words.
 *
 * ## Inert until the tenant has the line
 *
 * Everything here needs the tenant's REVIEWED `photo_price_question` row (a model-invisible
 * kind, `0083`): the question the customer is asked. A tenant without it keeps D-152 exactly.
 * So the switch is a row, not a code path (CLAUDE.md, "a client is rows").
 *
 * ## Photos only
 *
 * A video, a shared reel or post, or a link to one still goes to staff (D-152): the founder's
 * decision names photos, and the approved question says «зураг». Widening it is one condition
 * in `photoPriceStep` once the founder approves a line that fits a video.
 *
 * ## The steps
 *
 * The question has been asked when the bot's last reply is the question row itself, sent within
 * the last hour (`PHOTO_QUESTION_ANSWER_WINDOW_MS`; the Messenger worker measures it). A message
 * «crossed» it when the customer wrote it before the question arrived: a photo and «хэд вэ?»
 * typed together arrive as two messages, and the photo is answered first. Such a text is read
 * as the photo's caption.
 *
 *  - A photo (or a crossed caption) whose words fire a fixed reply with an answer (the dye rows,
 *    the address): `answer`, so it is served.
 *  - A price ask naming a listed service: `answer`, priced from the rows. A price ask naming
 *    none, no words, or only a greeting: `ask` the question once; if it was already asked and
 *    this is not a crossed caption, `handoff`; a crossed one gets nothing more (`wait`): the
 *    question just sent already asks what it needs.
 *  - Other words («ийм будаг хийж болох уу?»): `handoff`, as before. Whether it can be done is
 *    the stylist's to say, and the model cannot see the photo.
 *  - A text answering the question: `answer` when it names a service or fires any fixed reply
 *    or gate topic (the customer moved on: «хаяг хаана вэ?»), otherwise `handoff`. One
 *    question, then a person (the founder's "after one question").
 */
import { hasWord } from '../mn/match.ts';
import { maskUrls } from '../mn/extract.ts';
import { fold } from '../mn/text.ts';

/** The reviewed question a photo is answered with (`0083`). Model-invisible. */
export const PHOTO_PRICE_QUESTION_KIND = 'photo_price_question';

/**
 * Words with which a customer asks what something costs, Cyrillic and Latin-typed, matched as
 * WHOLE words (`hasWord`), so «хэд» is not found inside «хэдийд». Platform Mongolian, the same
 * for every tenant: matcher vocabulary, never a sentence the bot sends.
 */
export const ASKS_PRICE: readonly string[] = [
  'үнэ', 'үнээ', 'үнийг', 'үнийн', 'үнэтэй', 'үнэ нь', 'хэд', 'хэдэн', 'хэдээр', 'хэдвэ', 'хэдбэ',
  'une', 'vne', 'une ni', 'vne ni', 'uniin', 'vniin', 'unetei', 'vnetei',
  'hed', 'heden', 'hedeer', 'hedve', 'hedbe', 'hedv', 'hedwe', 'hedw', 'hd', 'hdve', 'hdv', 'hdwe',
];

/**
 * «хэд» also asks WHEN or HOW MANY DAYS («Хэдэн цагт ирэх вэ», «heden tsagt neeh ve», «Хэд
 * хоногийн дараа ирье»). A message carrying one of these words is not read as a price ask.
 */
export const NOT_A_PRICE_ASK: readonly string[] = [
  'цаг', 'цагт', 'цагаас', 'цагийн', 'хоног', 'хоногийн', 'хоногт',
  'tsag', 'tsagt', 'tsagaas', 'tsagiin', 'honog', 'honogiin', 'honogt',
];

/**
 * How long after the photo question a text still counts as written before it (`crossed`), from
 * Meta's time for the text to the question's row. A photo and «хэд вэ?» sent together arrive
 * seconds apart, and the question is sent about a second after the photo; a customer who began
 * typing before it arrived is not answering it. Thirty seconds covers that typing; a customer
 * who replies to the question inside it with only «хэд вэ?» gets nothing more for that message,
 * and their next one is answered or handed off.
 */
export const PHOTO_QUESTION_CROSSING_MS = 30_000;

/** Do the customer's words ask what something costs? */
export function asksPrice(text: string): boolean {
  return hasWord(text, ASKS_PRICE) && !hasWord(text, NOT_A_PRICE_ASK);
}

/** Is there a word left once links are masked? A photo sent with only a link or emoji has none. */
export function hasWords(text: string): boolean {
  return /\p{L}/u.test(maskUrls(text));
}

/** Is `reply` the question row, as sent? Folded and trimmed, never similar: an exact question. */
export function isPhotoQuestion(reply: string | null, question: string | null): boolean {
  if (reply === null || question === null) return false;
  const q = fold(question).trim();
  return q !== '' && fold(reply).trim() === q;
}

export type PhotoPriceStep =
  /** Nothing here applies: the path as it was before D-176. */
  | 'off'
  /** The rows can answer: skip the photo lines and answer as usual. */
  | 'answer'
  /** Send the question row. No hand-off. */
  | 'ask'
  /** Send the hand-off notice and pass the chat to staff (D-152's path). */
  | 'handoff'
  /** A caption that crossed the question: the question already answers it; send nothing more. */
  | 'wait';

/**
 * Where the conversation stands with the question, as the Messenger worker measured it from the
 * question's own row: `crossed` (the customer wrote before it arrived), `answering` (it was sent
 * within `PHOTO_QUESTION_ANSWER_WINDOW_MS`), `stale` (older: no longer a question being answered).
 * Absent (every other caller, and the reply cases) reads as `answering`.
 */
export type PhotoQuestionState = 'crossed' | 'answering' | 'stale';

/**
 * How long the question stays one the customer is answering. An answer to «which service and how
 * long is your hair?» comes within minutes; an hour later the conversation has moved on, and the
 * same bytes may be Tara's older `image_received` line from another day.
 */
export const PHOTO_QUESTION_ANSWER_WINDOW_MS = 60 * 60 * 1000;

export type PhotoPriceInput = {
  /** The tenant's reviewed question row, or null (then always `off`). */
  question: string | null;
  /** This message carries a photograph (never a sticker, D-070). */
  photo: boolean;
  /** A video, reel, shared post or a link to one: still D-152's hand-off. */
  otherMedia: boolean;
  /** The bot's last reply in the conversation. */
  previousReply: string | null;
  /** See `PhotoQuestionState`; meaningful only when `previousReply` is the question. */
  questionState: PhotoQuestionState;
  /** The words name a listed service (its name, an alias or its kind). */
  namesService: boolean;
  /**
   * Which of the tenant's fixed replies the words fire: `content` (an answer: the dye rows, the
   * address, the deposit), `smalltalk` (a whole-message row: a greeting, thanks, «ок»), or none.
   */
  fixedReply: 'content' | 'smalltalk' | null;
  /**
   * One of the tenant's gate topics fired (a refusal or a suitability rule). Counts only for a
   * text answering the question: on a photo's caption a «can it be done like this?» topic is
   * still the stylist's to answer, and a topic may fire on the attachment itself (D-083).
   */
  gateTopic: boolean;
  /** The words ask a price (`asksPrice`). */
  asksPrice: boolean;
  /** The message has a word once links are masked (`hasWords`). */
  hasWords: boolean;
};

/** The step for one customer message. Pure; every branch is in `photoPrice.test.ts`. */
export function photoPriceStep(s: PhotoPriceInput): PhotoPriceStep {
  if (s.question === null || s.otherMedia) return 'off';
  const asked = isPhotoQuestion(s.previousReply, s.question) && s.questionState !== 'stale';
  const crossed = asked && s.questionState === 'crossed';
  if (s.photo || crossed) {
    // A fixed reply with an answer (the dye rows for «будаг хэд вэ», the address) is served.
    if (s.fixedReply === 'content') return 'answer';
    // A price ask naming a service is priced from the rows; naming none, or saying nothing (no
    // words, a greeting), is asked once — and after that, a person.
    if (s.asksPrice || !s.hasWords || s.fixedReply === 'smalltalk') {
      if (s.asksPrice && s.namesService) return 'answer';
      if (!asked) return 'ask';
      return crossed ? 'wait' : 'handoff';
    }
    // Other words («ийм будаг хийж болох уу?»): whether it can be done is the stylist's.
    return 'handoff';
  }
  if (asked) return s.namesService || s.fixedReply !== null || s.gateTopic ? 'answer' : 'handoff';
  return 'off';
}

/**
 * A photo with no words (`planMediaAlone`), as the worker sees it: ask, or say nothing more to a
 * burst, or hand off because the question was already asked and words never came.
 *
 * `lastReply` is the bot's latest reply in the conversation, when it was made and its dedup key;
 * null when there is none. Unreadable is the caller's: it asks (a repeat is better than silence).
 * `ownKey` is the key this photo's question is drafted under: a redelivery of the same event finds
 * its own question and asks again (an idempotent draft), never hands off.
 */
export function photoAloneStep(input: {
  question: string;
  lastReply: { body: string; at: Date; dedupKey?: string | null } | null;
  ownKey: string;
  now: Date;
  burstWindowMs: number;
}): 'ask' | 'suppress' | 'handoff' {
  const last = input.lastReply;
  if (last === null || !isPhotoQuestion(last.body, input.question)) return 'ask';
  if (last.dedupKey === input.ownKey) return 'ask';
  const age = input.now.getTime() - last.at.getTime();
  if (Number.isNaN(age)) return 'ask';
  // Several photos sent together arrive as several messages: the question already answers them.
  if (age < input.burstWindowMs) return 'suppress';
  // A question from another day (or Tara's older image line, the same bytes) was not this one.
  if (age >= PHOTO_QUESTION_ANSWER_WINDOW_MS) return 'ask';
  return 'handoff';
}
