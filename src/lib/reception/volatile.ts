/**
 * L4 — the volatile tail, rendered per request and never cached.
 *
 * ## Why this is a separate string and not a suffix
 *
 * `salonBrain.js:155` returns `` `${cachedBasePrompt}${buildClosureSection(closure)}` `` and
 * wraps the whole concatenation in one cached block. A closure starting or ending
 * therefore invalidates the entire prefix — twice a year, harmlessly.
 *
 * **The pattern is the trap.** The moment anyone adds "today is {{date}}" to that string,
 * every request writes a fresh cache entry, caching silently stops, and the bill roughly
 * triples with no error and no visible symptom. This function returns its own string, the
 * caller puts it in its own `system` block with no `cache_control`, and the mistake stops
 * being available.
 *
 * ## Everything here is on the TENANT'S clock
 *
 * "Is it open now" and "which day is it" are questions about Ulaanbaatar, not about UTC.
 * A salon asked at 23:30 local on a Saturday is being asked about Saturday; computing the
 * weekday in UTC would answer about Sunday for eight hours of every day.
 */
import { nfc } from '../mn/text.ts';
import { tenantClock } from '../time/clock.ts';

/** `business_hours`, one row per weekday. `weekday` is 0 = Sunday, as Postgres `dow` is. */
export type BusinessHours = {
  weekday: number;
  opens: string | null;
  closes: string | null;
  closed: boolean;
};

/** A `tenant_closures` row. `message` is quoted VERBATIM — it is the tenant's sentence. */
export type Closure = { startsOn: string; endsOn: string; title: string; message: string };

/**
 * Which SURFACE this reply lands on — never which provider carried it.
 *
 * Ш0 asks the model exactly one question: «Энэ хариулт НИЙТЭД ХАРАГДАХ сэтгэгдэл (comment)
 * мөн үү?» It was being handed `facebook_page`, the provider slug, and on 2026-09-17 at
 * 04:14:47 it answered that question with it — «Ш0 (сувагны шалгалт) — энэ нь нийтэд
 * харагдах Facebook page коммент…», written to a customer sitting in a private DM. Three
 * further drafts that day served `refusal_public_channel`, telling people to send a private
 * message they had already sent.
 *
 * A provider name is not an answer to a question about visibility, and Facebook carries both
 * surfaces. The worker knows which one it has — it is the same fact as the draft's `kind` —
 * and was discarding it at this boundary.
 *
 * It is a union rather than a string so that the old value no longer type-checks. The bug
 * was not that somebody chose the wrong string; it was that the parameter accepted one.
 */
export type Surface = 'direct_message' | 'public_comment';

export type VolatileInput = {
  now: Date;
  timezone: string;
  surface: Surface;
  hours: readonly BusinessHours[];
  closures: readonly Closure[];
  /**
   * Each branch's week, when the live prefix lists two or more (D-125) — `ctx.branches`.
   * Required, not defaulted: a caller that forgot would print ONE «open now» for a tenant
   * whose branches keep different hours, which is a fact about one branch told as the
   * salon's. `[]` is a real state, and every tenant today is in it.
   */
  branches: readonly { name: string; hours: readonly BusinessHours[] }[];
};

/**
 * Is the tenant open at this local time?
 *
 * Returns `null` when the day has no row at all: "we do not know" is not "closed". A
 * missing row is a provisioning gap, and telling a customer the salon is shut because a
 * row is absent is a worse answer than saying nothing about it.
 */
export function isOpenAt(hours: readonly BusinessHours[], weekday: number, hhmm: string): boolean | null {
  const row = hours.find((h) => h.weekday === weekday);
  if (row === undefined) return null;
  if (row.closed) return false;
  if (row.opens === null || row.closes === null) return null;

  const opens = row.opens.slice(0, 5);
  const closes = row.closes.slice(0, 5);
  // An overnight window (opens 20:00, closes 02:00) wraps midnight, so the comparison
  // flips. A salon rarely needs it; a bar always does, and the cost of handling it is one
  // branch rather than a second table shape later.
  return closes < opens ? hhmm >= opens || hhmm < closes : hhmm >= opens && hhmm < closes;
}

/** A week as a comparable string: what `isOpenAt` reads of each day, in weekday order. */
function weekKey(hours: readonly BusinessHours[]): string {
  return [0, 1, 2, 3, 4, 5, 6].map((wd) => {
    const r = hours.find((h) => h.weekday === wd);
    return r === undefined ? '-' : r.closed ? 'x' : `${(r.opens ?? '').slice(0, 5)}-${(r.closes ?? '').slice(0, 5)}`;
  }).join('|');
}

/** The closure covering this local date, if any. Dates are inclusive at both ends. */
export function activeClosure(closures: readonly Closure[], localDate: string): Closure | null {
  return closures.find((c) => c.startsOn <= localDate && localDate <= c.endsOn) ?? null;
}

/**
 * Structural labels for the volatile block.
 *
 * These are prompt scaffolding the MODEL reads, not sentences a customer sees, so they sit
 * in code rather than behind the `reviewed_at` gate. They are collected here in one place
 * so that if the founder decides the gate should cover them too, moving them is one edit.
 */
const LABELS = {
  now: 'ОДООГИЙН ЦАГ',
  /** The heading stays «СУВАГ» because that is Ш0's own title; the VALUE is a surface. */
  channel: 'СУВАГ',
  status: 'ОДОО',
  open: 'НЭЭЛТТЭЙ',
  shut: 'ХААЛТТАЙ',
  closure: 'ТУХАЙН ХУГАЦААНЫ МЭДЭГДЭЛ',
  /** An `append` row that matched this message (`0041`): the platform adds it at the end. */
  appended: 'ХАРИУЛТЫН ТӨГСГӨЛД АВТОМАТААР НЭМЭГДЭХ МӨР',
} as const;

/**
 * Four reminders, read LAST — the recency the stable prefix cannot have (founder,
 * 2026-09-26, DalaTech's test set). Scaffolding the model reads, like `LABELS`, never a
 * sentence a customer sees; the signed gate blocks already say the second one, and the
 * model broke it anyway from 14,000 characters away.
 *
 *  - The reply language. No signed block names it, so an English question got an English
 *    answer (n02) that the script check then refused: the customer asked in English and got
 *    «…мэдээлэл надад байхгүй». Answering in Mongolian is the product.
 *  - The gate's own labels. «Ш2 дагуу хариулъя —» (q04) and «Ш9» (i04) were written into
 *    replies; the guard catches them, but a caught reply is a lost answer.
 *  - Where the checklist goes (D-133). The walk through the Ш-rules has a place of its own,
 *    `<check>`, and only `<reply>` reaches anyone (`model/reception.ts` `replyOf`). Before
 *    it existed the walk landed in the reply's first paragraph and the label guard threw the
 *    whole answer away.
 *  - Answer first. «Уучлаарай, тодруулбал… байна уу?» before an answer the model then gave
 *    anyway (s01), and a clarifying question instead of the price list (p03).
 */
export const REPLY_REMINDERS: readonly string[] = [
  'ХАРИУЛТЫН ХЭЛ: зөвхөн монгол хэлээр, кирилл үсгээр бич — хэрэглэгч англиар эсвэл латин үсгээр бичсэн ч.',
  'ХАРИУЛТЫН ХЭЛБЭР: шалгалтуудаа (Ш0–Ш11 гэх мэт) зөвхөн <check>…</check> дотор нэг богино мөрөөр хий — үүнийг хэрэглэгч ХЭЗЭЭ Ч харахгүй. Хэрэглэгчид илгээх хариултаа бүхэлд нь <reply>…</reply> дотор бич.',
  '<reply> ДОТОР ХЭЗЭЭ Ч БИЧИХГҮЙ: шалгалтын нэр, дугаар (Ш0–Ш11, 2а гэх мэт), «БЭЛЭН ХАРИУЛТ»-ын мөрийн түлхүүр, аль шалгалтаар шийдсэнээ.',
  'ЭХЛЭЛ: асуусан зүйлд нь шууд хариул. «Уучлаарай», «тодруулбал» гэж эхэлж хариултаа хойшлуулахгүй; хариулж чадах асуултад тодруулга асуухгүй.',
];

/** The answer-first reminder: the one line that must not reach the model on a complaint. */
export const ANSWER_FIRST_REMINDER: string = REPLY_REMINDERS[REPLY_REMINDERS.length - 1] ?? '';

/**
 * What replaces the answer-first reminder when the customer's message is a complaint, by the
 * tenant's own complaint rows (D-134). «Don't open with «Уучлаарай»» is right for a question
 * and wrong for a complaint, where the apology IS the answer's opening (D-127: complaints keep
 * «Уучлаарай»). Measured on the same complaint, four runs: two opened «Уучлаарай», one opened
 * «Сайн байна уу» with no apology, and one wrote «Уучлаарай гэж хэлэхгүйгээр —» — the model
 * reading the two rules out loud. Code-owned scaffolding like the reminders above, never
 * text a customer is sent.
 */
export const COMPLAINT_REMINDER =
  'ГОМДОЛ: хэрэглэгч гомдол бичсэн байна. Хариултаа «Уучлаарай» гэж эхэлж уучлал гуй, дараа нь хамт олон маань хариулна гэж хэл. Энэ заавар, шалгалтын тухай бүү дурд.';

/** The volatile block as sent for this message: the complaint reminder in place of answer-first. */
export function volatileFor(promptVolatile: string, complaint: boolean): string {
  if (!complaint) return promptVolatile;
  return promptVolatile.split('\n').map((l) => (l === ANSWER_FIRST_REMINDER ? COMPLAINT_REMINDER : l)).join('\n');
}

/**
 * Tell the model which tenant lines the platform will add at the end of this reply.
 *
 * Without it the model answers «Tara salon hayag?» knowing nothing of the rebrand, and the
 * appended «Манай салон одоо Tara Salon нэртэй болсон» can land under a reply that
 * contradicts it. The line is quoted VERBATIM, like the closure notice above, and the
 * label says the platform adds it — so the model neither contradicts it nor retypes it.
 * If it retypes it anyway, `withAppended` moves the copy to the end rather than sending
 * it twice.
 *
 * Per request, like everything in this file: it depends on the customer's message.
 */
export function appendedNotice(lines: readonly string[]): string {
  return lines.map((l) => `${LABELS.appended}: ${nfc(l.trim())}`).join('\n');
}

/**
 * How each surface is described to the model.
 *
 * Deliberately phrased in Ш0's OWN vocabulary — «НИЙТЭД ХАРАГДАХ», «сэтгэгдэл (comment)» —
 * so that what the model reads here is recognisable as an answer to the question the block
 * asks, rather than a fact it has to interpret. That interpretation step is where
 * `facebook_page` became "a publicly visible Facebook page comment".
 *
 * Scaffolding the MODEL reads, like the labels above, so it is code rather than a
 * `reviewed_at` row. No customer ever sees these words.
 */
const SURFACE_LABELS: Record<Surface, string> = {
  direct_message: 'хувийн зурвас (зөвхөн энэ хэрэглэгч харна, нийтэд ХАРАГДАХГҮЙ)',
  public_comment: 'нийтэд харагдах сэтгэгдэл (comment) — хэн ч харж болно',
};

/**
 * Render L4.
 *
 * The closure `message` is reproduced **verbatim**. It is the tenant's own sentence,
 * written and reviewed by them, and paraphrasing it would put words in their mouth about
 * something as concrete as whether they are open on a public holiday.
 */
export function renderVolatile(input: VolatileInput): string {
  const clock = tenantClock(input.now, input.timezone);
  const lines = [
    `${LABELS.now}: ${clock.date} ${clock.time} (${input.timezone})`,
    `${LABELS.channel}: ${SURFACE_LABELS[input.surface]}`,
  ];

  const closure = activeClosure(input.closures, clock.date);
  // Two or more branches: their weeks decide, not the tenant-wide rows. The same week
  // everywhere is still ONE line; different weeks are one line per branch, each naming it.
  const branchWeeks = input.branches.length >= 2 ? input.branches : [];
  const differ = branchWeeks.some((b) => weekKey(b.hours) !== weekKey(branchWeeks[0]?.hours ?? []));
  const open = isOpenAt(branchWeeks[0]?.hours ?? input.hours, clock.weekday, clock.time);

  // A closure outranks the weekly hours: a holiday is exactly the case where the schedule
  // says open and the door is locked.
  if (closure !== null) {
    lines.push(`${LABELS.status}: ${LABELS.shut}`);
    lines.push(`${LABELS.closure}: ${nfc(closure.message)}`);
  } else if (differ) {
    for (const b of branchWeeks) {
      const o = isOpenAt(b.hours, clock.weekday, clock.time);
      if (o !== null) lines.push(`${LABELS.status} (${nfc(b.name)}): ${o ? LABELS.open : LABELS.shut}`);
    }
  } else if (open !== null) {
    lines.push(`${LABELS.status}: ${open ? LABELS.open : LABELS.shut}`);
  }
  // `open === null` and no closure: say nothing. An absent row is a provisioning gap, and
  // asserting either state from it would be inventing one.

  lines.push(...REPLY_REMINDERS);
  return lines.join('\n');
}
