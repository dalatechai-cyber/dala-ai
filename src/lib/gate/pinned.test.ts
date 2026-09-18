import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPinnedLines, similarity, NEAR_COPY_MIN_SIMILARITY } from './pinned.ts';
import type { CannedRow } from './match.ts';

const REVIEWED = '2026-09-07T00:00:00Z';

/** Matrix's real rows, as they stand on the project. The overlap between them is the point. */
const HANDOFF = 'Уучлаарай, би энэ асуултад хариулж чадахгүй байна. Манай ажилтан Танд туслахад бэлэн байна. Та 7741-7777 дугаараар холбогдоно уу.';
const PRICE = 'Уучлаарай, энэ үйлчилгээний үнийн мэдээлэл надад байхгүй байна. Та 7741-7777 дугаараар холбогдоно уу.';
const STAFF = 'Үсчдийн ажлын хуваарь, ирцийн мэдээлэл надад байхгүй. Та 7741-7777 дугаараар лавлана уу.';

const CANNED: CannedRow[] = [
  { kind: 'handoff', body: HANDOFF, reviewedAt: REVIEWED },
  { kind: 'refusal_price_unlisted', body: PRICE, reviewedAt: REVIEWED },
  { kind: 'refusal_staff_schedule', body: STAFF, reviewedAt: REVIEWED },
];

test('DONE-TEST: THE MEASURED PARAPHRASE — one word dropped from a pinned line', () => {
  // Matrix, 2026-09-14, the third draft the mirror ever produced, nine minutes after the
  // webhook came back. «би» is gone; 128 characters against the row's 129.
  //
  // The draft nine minutes earlier is byte-exact and is not a counter-example: its
  // `quality_flags` row shows the outbound guard refused the model's text and `handoff()`
  // served the row. The platform typed that one. On the ONLY occasion the model typed a
  // pinned line itself, it got it wrong.
  //
  // Every customer-visible sentence on this platform rests on the same arrangement, and
  // `reviewed_at` cannot see this, because the gate is on the row and not on what came back.
  const drift = 'Уучлаарай, энэ асуултад хариулж чадахгүй байна. Манай ажилтан Танд туслахад бэлэн байна. Та 7741-7777 дугаараар холбогдоно уу.';
  const v = checkPinnedLines(drift, CANNED);
  assert.equal(v.kind, 'paraphrase');
  assert.equal(v.kind === 'paraphrase' && v.canonicalKind, 'handoff');
  // The ROW's bytes, not a repaired version of what the model typed.
  assert.equal(v.kind === 'paraphrase' && v.canonical, HANDOFF);
  assert.ok(v.kind === 'paraphrase' && v.similarity > 0.97, String(v.kind === 'paraphrase' && v.similarity));
});

test('a byte-exact copy is exact, and still answers from the row', () => {
  // Not redundant with `clean`: the provenance is wrong if this reports as a model answer.
  // A reply that IS the handoff line was answered by a canned line whoever assembled the
  // characters, and the corpus the mirror exists to produce must say so.
  const v = checkPinnedLines(HANDOFF, CANNED);
  assert.equal(v.kind, 'exact');
  assert.equal(v.kind === 'exact' && v.canonical, HANDOFF);
});

test('whitespace differences are exact, and the ROW\'s spacing is what is served', () => {
  // The whitespace a founder approved is part of what was approved. Normalising to compare
  // must not become a second source of the sentence.
  const spaced = HANDOFF.replace('байна. Манай', 'байна.\n\n  Манай');
  const v = checkPinnedLines(spaced, CANNED);
  assert.equal(v.kind, 'exact');
  assert.equal(v.kind === 'exact' && v.canonical, HANDOFF, 'the row, not the model\'s spacing');
});

test('DONE-TEST: A REAL ANSWER IS NEVER REPLACED BY A REFUSAL', () => {
  // The dangerous direction. Too low a threshold and a correct answer becomes a refusal,
  // which is worse than the paraphrase this file exists to catch — so the length guard, not
  // the ratio, carries most of the safety.
  const real = 'Чёлк тайралт 33,000₮ байна. Цаг захиалахыг хүсвэл 7741-7777 дугаараар холбогдоно уу.';
  assert.equal(checkPinnedLines(real, CANNED).kind, 'clean');
});

test('a long answer that merely quotes the closing sentence is clean', () => {
  // Every one of Matrix's refusals ends with the same phone-number sentence, so substring
  // overlap alone would condemn any reply that closes politely.
  const long = 'Манай салон 10:00-20:00 цагт ажиллана. Үсчдийн жагсаалт, үйлчилгээний нэрсийг '
    + 'вэбсайтаас харна уу. Нэмэлт асуулт байвал Та 7741-7777 дугаараар холбогдоно уу.';
  assert.equal(checkPinnedLines(long, CANNED).kind, 'clean');
});

test('DONE-TEST: AN UNREVIEWED ROW IS NOT A PINNED LINE', () => {
  // Substituting toward an unreviewed row would ship Mongolian nobody signed off on, on the
  // strength of the model having roughly typed it — the review gate defeated by the very
  // mechanism built to enforce it. `handleReception`'s `canned()` refuses them for the same
  // reason, and this is the same refusal one layer over.
  const unreviewed: CannedRow[] = [{ kind: 'handoff', body: HANDOFF, reviewedAt: null }];
  assert.equal(checkPinnedLines(HANDOFF, unreviewed).kind, 'clean');
});

test('the CLOSEST line wins when several overlap', () => {
  // Matrix's kinds share their last sentence, so answering with the second-best would be a
  // new way of saying the wrong thing — a refusal about staff rotas to a price question.
  const drift = PRICE.replace('надад байхгүй байна', 'надад алга байна');
  const v = checkPinnedLines(drift, CANNED);
  assert.equal(v.kind, 'paraphrase');
  assert.equal(v.kind === 'paraphrase' && v.canonicalKind, 'refusal_price_unlisted');
});

test('NFC first: a decomposed Ё is the same sentence', () => {
  // CLAUDE.md rule 6. «Ёлка» decomposed is not «Ёлка» composed, and a comparison that skips
  // normalisation reports a perfect copy as a paraphrase — which would flag every reply
  // whose provider happened to return NFD.
  const rows: CannedRow[] = [{ kind: 'greeting', body: 'Ёлка байна уу?', reviewedAt: REVIEWED }];
  assert.equal(checkPinnedLines('Ёлка байна уу?'.normalize('NFD'), rows).kind, 'exact');
});

test('the distance is over CODE POINTS, so an emoji costs one character', () => {
  // `.length` counts UTF-16 units. An astral character is two of them and one character, and
  // measuring in units would silently shift every ratio in this file the first time a reply
  // carried an emoji — which the ancestor's replies routinely do.
  assert.equal(similarity('аб😀', 'аб😀'), 1);
  // One character differs out of three, not one out of four.
  assert.ok(Math.abs(similarity('аб😀', 'ав😀') - 2 / 3) < 1e-9, String(similarity('аб😀', 'ав😀')));
});

test('an empty reply, and a tenant with no rows, are both clean', () => {
  assert.equal(checkPinnedLines('', CANNED).kind, 'clean');
  assert.equal(checkPinnedLines(HANDOFF, []).kind, 'clean');
  assert.equal(NEAR_COPY_MIN_SIMILARITY, 0.9);
});

// ---------------------------------------------------------------------------
// D-077 addendum — an approved line adapted INSIDE a longer reply
// ---------------------------------------------------------------------------

const PRICE_ROW = {
  kind: 'refusal_price_unlisted',
  body: 'Уучлаарай, энэ үйлчилгээний үнийн мэдээлэл надад байхгүй байна. Та 7741-7777 дугаараар холбогдож лавлана уу.',
  reviewedAt: '2026-09-07T00:00:00Z',
};
const BOOKING_ROW = {
  kind: 'booking_line',
  body: 'Та манай вэбсайтаар (https://www.matrixecosalon.org/) онлайнаар цаг захиалж, урьдчилгаа төлбөрөө QPay-ээр төлөх боломжтой.',
  reviewedAt: '2026-09-07T00:00:00Z',
};
const ROWS = [PRICE_ROW, BOOKING_ROW];

test('DONE-TEST: AN ADAPTED LINE INSIDE A LONGER REPLY IS DRIFT, AND IS CORRECTED', () => {
  // Production, 2026-09-16 11:26:29. «Шулуун химийн» in place of «энэ үйлчилгээний» —
  // better than the row, and still a sentence nobody reviewed carrying an approved one's
  // meaning. MIN_LENGTH_RATIO rejected it before similarity was computed, so until now it
  // was neither corrected nor counted.
  const reply = 'Сайн байна уу.\n\nШулуун химийн үнийн мэдээлэл надад байхгүй байна. '
    + 'Та 7741-7777 дугаараар холбогдож лавлана уу.\n\nМанай хаяг: https://maps.app.goo.gl/fHaBVwc9mFZJxYAJ9';
  const v = checkPinnedLines(reply, ROWS);
  assert.equal(v.kind, 'paraphrase');
  assert.equal(v.kind === 'paraphrase' && v.canonicalKind, 'refusal_price_unlisted');
  assert.equal(v.kind === 'paraphrase' && v.canonical, PRICE_ROW.body);
});

test('DONE-TEST: AN EXACT QUOTATION INSIDE A LONGER REPLY IS LEFT ALONE', () => {
  // 2026-09-14 «tsag avii». The model declined what it cannot do, said why, and reproduced
  // `booking_line` CORRECTLY. Composing around an approved line is what a helpful answer
  // does, and replacing this with the bare row would be the D-068 failure by another route.
  const reply = `Уучлаарай, би цаг захиалж чадахгүй. ${BOOKING_ROW.body} Өөр асуулт байвал асуугаарай.`;
  assert.equal(checkPinnedLines(reply, ROWS).kind, 'clean');
});

test('the shared phone sentence alone is not drift', () => {
  // «Та 7741-7777 дугаараар холбогдоно уу.» is 36 characters and ends several rows. A reply
  // may legitimately end that way without having reproduced any particular one — which is
  // what EMBEDDED_MIN_RUN is for.
  const reply = 'Манай ажилтан Танд туслах болно. Та 7741-7777 дугаараар холбогдоно уу.';
  assert.equal(checkPinnedLines(reply, ROWS).kind, 'clean');
});

test('an unreviewed row is never the canonical answer, embedded or not', () => {
  // Measuring against an unreviewed row and then SERVING it would defeat the review gate
  // with the mechanism built to enforce it.
  const unreviewed = [{ ...PRICE_ROW, reviewedAt: null }];
  const reply = 'Сайн байна уу. Шулуун химийн үнийн мэдээлэл надад байхгүй байна. '
    + 'Та 7741-7777 дугаараар холбогдож лавлана уу. Баярлалаа.';
  assert.equal(checkPinnedLines(reply, unreviewed).kind, 'clean');
});

test('a reply sharing only a short fragment is left alone', () => {
  assert.equal(checkPinnedLines('Уучлаарай, тийм мэдээлэл надад байхгүй.', ROWS).kind, 'clean');
});

test('the whole-reply exact and paraphrase verdicts are unchanged', () => {
  assert.equal(checkPinnedLines(PRICE_ROW.body, ROWS).kind, 'exact');
  // One letter dropped, same length class — the D-065 case the original check was built for.
  const near = PRICE_ROW.body.replace('Уучлаарай, ', 'Уучлаарай ');
  assert.equal(checkPinnedLines(near, ROWS).kind, 'paraphrase');
});

// ---------------------------------------------------------------------------
// A row the model was never shown is not a row it adapted. D-083.
// ---------------------------------------------------------------------------

const SHARED_INVITE = 'Хүссэн үйлчилгээ, үсний урт, өнгөө бичвэл баяртайгаар хариулна.';
const IMAGE_ROW = {
  kind: 'image_received',
  body: `Уучлаарай, би зураг харах боломжгүй. ${SHARED_INVITE}`,
  reviewedAt: '2026-09-18',
};
/** Matrix's reworded consultation refusal — it ends with the same invitation. */
const OOS_ROW = {
  kind: 'refusal_out_of_scope',
  body: `Уучлаарай, ямар үйлчилгээ, өнгө Танд тохирохыг би шийдэж өгөх боломжгүй. ${SHARED_INVITE}`,
  reviewedAt: '2026-09-18',
};

test('A FILTERED ROW IS NEVER THE CANONICAL ONE, even when it scores highest', () => {
  // `image_received` is excluded from the compiled prefix (D-082), so the model never read
  // it. With it still a pinning candidate, a reply that keeps the shared invitation and
  // rewords the sentence before it resolves to `image_received` — `embeddedAdaptation`
  // picks the longest common RUN and the shorter row wins on run-over-length. The customer
  // asked which colour suits them and would have been told the bot cannot see pictures.
  const reply = `Уучлаарай, Танд юу тохирохыг би хэлж чадахгүй. ${SHARED_INVITE}`;
  const v = checkPinnedLines(reply, [OOS_ROW, IMAGE_ROW]);
  assert.notEqual(v.kind === 'paraphrase' && v.canonicalKind, 'image_received');
  assert.equal(v.kind, 'clean', 'a coincidence with an unshown row is not drift');
});

test('the visible row still resolves correctly, exactly and as drift', () => {
  // The filter must not cost the mechanism its actual job.
  const exact = checkPinnedLines(OOS_ROW.body, [OOS_ROW, IMAGE_ROW]);
  assert.equal(exact.kind, 'exact');
  assert.equal(exact.kind === 'exact' && exact.canonicalKind, 'refusal_out_of_scope');

  // D-065's real drift: the model dropped «би» from a pinned line.
  const drift = checkPinnedLines(OOS_ROW.body.replace(' би ', ' '), [OOS_ROW, IMAGE_ROW]);
  assert.equal(drift.kind, 'paraphrase');
  assert.equal(drift.kind === 'paraphrase' && drift.canonicalKind, 'refusal_out_of_scope');
  assert.equal(drift.kind === 'paraphrase' && drift.canonical, OOS_ROW.body, 'the row\'s own bytes');
});

test('an unreviewed row is still excluded, and for the same reason', () => {
  const unreviewed = { ...OOS_ROW, reviewedAt: null };
  assert.equal(checkPinnedLines(OOS_ROW.body, [unreviewed]).kind, 'clean');
});
