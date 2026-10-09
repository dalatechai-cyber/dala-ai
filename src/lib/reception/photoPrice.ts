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
 * ## Photos, and videos with their own line
 *
 * A video, a shared reel or a link to one is handled the same way, with its own reviewed row
 * (`reel_price_question`, founder 2026-10-04: «Уучлаарай, би бичлэг харах боломжгүй. …»), because
 * the photo line says «зураг». Each kind is switched on by its own row: a tenant with only the
 * photo row keeps D-152 for videos, and the reverse. A shared post, a link to a post, a photo, a
 * story or a pin (it may be a picture, and the line says «бичлэг»), and a photo beside a video,
 * still go to staff (`unseenMediaOf`, D-152).
 *
 * The two questions are one question: either, sent within the hour, is "the question" for what
 * follows. A reel after the photo question (or a photo after the reel question) is a second
 * picture after one question, so it goes on exactly as a second photo would.
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
 *  - A crossed text naming ONE listed service by name or alias («Tara perm урт», sent 13 s after
 *    the question): `answer`. It is the answer to the question, typed fast; the 10 s crossing
 *    window must not turn it into a caption. A kind alone («ийм будаг») still goes to staff.
 *  - A text answering the question: `answer` when it names a service or fires any fixed reply
 *    or gate topic (the customer moved on: «хаяг хаана вэ?»), otherwise `handoff`. One
 *    question, then a person (the founder's "after one question").
 */
import { hasWord } from '../mn/match.ts';
import { maskUrls } from '../mn/extract.ts';
import { fold } from '../mn/text.ts';

/** The reviewed question a photo is answered with (`0083`). Model-invisible. */
export const PHOTO_PRICE_QUESTION_KIND = 'photo_price_question';

/** The reviewed question a video, a reel or a link to one is answered with (`0083`). Model-invisible. */
export const REEL_PRICE_QUESTION_KIND = 'reel_price_question';

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
 * typing before it arrived is not answering it. The one measured crossing took 3.1 s (Парк Од,
 * 2026-10-09 02:18:36.9 against the question's row at 02:18:33.8); the same customer's reply after
 * reading the question came 21 s after it. Ten seconds covers the crossing with margin and no
 * longer: a text inside it gets nothing more, so a wider window is a window of silence (D-182).
 */
export const PHOTO_QUESTION_CROSSING_MS = 10_000;

/**
 * How close a second picture must be to the photo question, with nothing written between, to
 * count as sent together with the first (it then gets nothing more). Measured on the server's
 * clock: each picture is its own job, so it allows for a job that starts late. A later picture
 * gets the hand-off notice and a person is told.
 */
export const PHOTO_BATCH_MS = 30_000;

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

/** Is `reply` one of the tenant's question rows (the photo's or the reel's)? */
export function isMediaQuestion(reply: string | null, questions: readonly (string | null)[]): boolean {
  return questions.some((q) => isPhotoQuestion(reply, q));
}

/** The row a message carrying `media` is asked with, or null (no such row, or not a kind with one). */
export function questionFor(media: UnseenMedia | null, rows: { photo: string | null; reel: string | null }): string | null {
  if (media === 'photo') return rows.photo;
  if (media === 'video') return rows.reel;
  return null;
}

/** What the message carries that the bot cannot see (`handover/media.ts`, `unseenMediaOf`). */
export type UnseenMedia = 'photo' | 'video' | 'mixed';

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
 * question's own row: `crossed` (the customer wrote before it arrived, and nothing else since:
 * one message can cross it, never two), `answering` (within `PHOTO_QUESTION_ANSWER_WINDOW_MS`),
 * `stale` (older: no longer a question being answered). Absent (every other caller, and the reply
 * cases) reads as `answering`. There was a `burst` state (a second picture within 10 minutes got
 * nothing); it went on 2026-10-09 (founder): a picture minutes after the question was sent after
 * reading it, and silence then tells nobody.
 */
export type PhotoQuestionState = 'crossed' | 'answering' | 'stale';

/**
 * How long the question stays one the customer is answering. An answer to «which service and how
 * long is your hair?» comes within minutes; an hour later the conversation has moved on, and the
 * same bytes may be Tara's older `image_received` line from another day.
 */
export const PHOTO_QUESTION_ANSWER_WINDOW_MS = 60 * 60 * 1000;

export type PhotoPriceInput = {
  /** The tenant's reviewed photo question row, or null. */
  question: string | null;
  /** The tenant's reviewed reel question row, or null. With both null: always `off`. */
  reelQuestion: string | null;
  /**
   * What this message carries that the bot cannot see: a photograph (never a sticker, D-070), a
   * video or reel or a link to one, `mixed` (a shared post, or a photo beside a video: still
   * D-152's hand-off), or null.
   */
  media: UnseenMedia | null;
  /** The bot's last reply in the conversation. */
  previousReply: string | null;
  /** See `PhotoQuestionState`; meaningful only when `previousReply` is the question. */
  questionState: PhotoQuestionState;
  /**
   * A photo or reel question was asked earlier within `PHOTO_QUESTION_ANSWER_WINDOW_MS` and the
   * bot has said something else since (a price answered, say). A picture now is not asked again:
   * one question, then a person (founder, 2026-10-09: a second photo got the question twice).
   * Absent reads as false.
   */
  askedEarlier?: boolean;
  /** The words name a listed service (its name, an alias or its kind). */
  namesService: boolean;
  /**
   * The words name exactly ONE listed service, by its name or an alias («Tara perm урт»), not
   * only a kind («ийм будаг»). A text that crossed the question and says this much is the answer
   * to it, typed fast, and is priced from the rows (founder, 2026-10-04: «Tara perm урт» 13 s
   * after the question was handed to staff).
   */
  namesOneService: boolean;
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
  /** The words, links masked, ask a price (`asksPrice`). */
  asksPrice: boolean;
  /** The message has a word once links are masked (`hasWords`). */
  hasWords: boolean;
};

/** The step for one customer message. Pure; every branch is in `photoPrice.test.ts`. */
export function photoPriceStep(s: PhotoPriceInput): PhotoPriceStep {
  // A picture of a kind this tenant has no row for, or a mixed one: D-152 exactly.
  if (s.media !== null && questionFor(s.media, { photo: s.question, reel: s.reelQuestion }) === null) return 'off';
  const asked = isMediaQuestion(s.previousReply, [s.question, s.reelQuestion]) && s.questionState !== 'stale';
  const crossed = asked && s.questionState === 'crossed';
  if (s.media !== null || crossed) {
    // A fixed reply with an answer (the dye rows for «будаг хэд вэ», the address) is served.
    if (s.fixedReply === 'content') return 'answer';
    // A price ask naming a service is priced from the rows; naming none, or saying nothing (no
    // words, a greeting), is asked once — and after that, a person.
    if (s.asksPrice || !s.hasWords || s.fixedReply === 'smalltalk') {
      if (s.asksPrice && s.namesService) return 'answer';
      if (!asked) return s.media !== null && s.askedEarlier === true ? 'handoff' : 'ask';
      // Crossed: the question already asks what it needs, as for a second photo sent together.
      // Anything after that: a person (the notice, and the alert where the tenant has it).
      return crossed ? 'wait' : 'handoff';
    }
    // A text that crossed the question naming one listed service («Tara perm урт»): the answer
    // to the question, typed within the crossing window. Priced from the rows, as it would be a
    // few seconds later. Not a caption on the picture itself, and not a kind alone.
    if (crossed && s.media === null && s.namesOneService) return 'answer';
    // Other words («ийм будаг хийж болох уу?»): whether it can be done is the stylist's.
    return 'handoff';
  }
  if (asked) return s.namesService || s.fixedReply !== null || s.gateTopic ? 'answer' : 'handoff';
  return 'off';
}

/**
 * A photo, a video or a reel with no words (`planMediaAlone`), as the worker sees it: ask, or say
 * nothing more to a burst, or hand off because a question was already asked and words never came.
 * `questions` are the tenant's reviewed question rows (the photo's and the reel's): either, as
 * the last reply, is the question already asked.
 *
 * `lastReply` is the bot's latest reply in the conversation, when it was made and its dedup key;
 * null when there is none. Unreadable is the caller's: it asks (a repeat is better than silence).
 * `ownKey` is the key this photo's question is drafted under: a redelivery of the same event finds
 * its own question and asks again (an idempotent draft), never hands off.
 */
export function photoAloneStep(input: {
  questions: readonly string[];
  lastReply: { body: string; at: Date; dedupKey?: string | null } | null;
  /**
   * The latest question in the hour (`readRecentMediaQuestion`), whether it is still the last
   * reply, and whether the customer wrote since; null when none. Absent: read from `lastReply`
   * alone, as before (the question is the last reply, nothing written since).
   */
  recent?: { at: Date; isLastReply: boolean; customerWroteSince: boolean; dedupKey?: string | null } | null;
  ownKey: string;
  now: Date;
  /** A second picture this soon after the question was sent together with the first. */
  togetherMs: number;
}): 'ask' | 'suppress' | 'handoff' {
  const last = input.lastReply;
  // A redelivery of the same event finds its own question: asked again (an idempotent draft).
  if (last !== null && last.dedupKey === input.ownKey && isMediaQuestion(last.body, input.questions)) return 'ask';
  const recent = input.recent !== undefined ? input.recent
    : last !== null && isMediaQuestion(last.body, input.questions) ? { at: last.at, isLastReply: true, customerWroteSince: false } : null;
  if (recent === null) return 'ask';
  // The same, when a reply drafted after it (a price for the words sent with this picture) hides
  // the question from `lastReply`: the event's own question is never a reason to hand off.
  if (recent.dedupKey === input.ownKey) return 'ask';
  const age = input.now.getTime() - recent.at.getTime();
  if (Number.isNaN(age)) return 'ask';
  // A question from another day (or Tara's older image line, the same bytes) was not this one.
  if (age >= PHOTO_QUESTION_ANSWER_WINDOW_MS) return 'ask';
  // Several photos (or reels) sent together arrive as several messages seconds apart: the
  // question already answers them. Only that: a picture after the customer wrote, after another
  // reply, or later than «together» comes after the question was read, and goes to a person
  // (founder, 2026-10-09: a second photo after «tara perm urt» was asked the question again).
  if (recent.isLastReply && !recent.customerWroteSince && age < input.togetherMs) return 'suppress';
  return 'handoff';
}
