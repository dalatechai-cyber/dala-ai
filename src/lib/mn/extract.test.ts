import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalizeUrl,
  containsPercentage,
  digitsOf,
  extractNumerals,
  extractUrls,
  numeralsNotAllowed,
  urlsNotAllowed,

  maskUrls,
  percentagesIn,
  tenantPercentages,} from './extract.ts';

// Matrix Eco Salon's real price strings, from `currentClient.js`. These are the values
// the compiler puts in `config_snapshots.allowed_numbers`.
const ALLOWED = ['33,000', '22,000', '45,000', '7741-7777', '10:00', '20:00'];

// ---------------------------------------------------------------------------
// The V1.md 3.4 done-test: every numeral in the reply appears in allowed_numbers.
// ---------------------------------------------------------------------------

test('DONE-TEST: an injected fake price fails the guard', () => {
  // V1.md 3.4, verbatim: "An injected fake price fails the guard and falls back to the
  // canned refusal." This is that test.
  const injected = 'Хөмсөг засалт 20,000₮ байна.';
  assert.deepEqual(numeralsNotAllowed(injected, ALLOWED), ['20,000']);
});

test('a reply quoting only real prices passes', () => {
  const good = 'Чёлк тайралт 33,000₮, угаалт 22,000₮ байна. 7741-7777 дугаараар холбогдоно уу.';
  assert.deepEqual(numeralsNotAllowed(good, ALLOWED), []);
});

test('reformatting is not invention — 33,000 and 33 000 and 33000 are the same number', () => {
  for (const form of ['33,000₮', '33 000₮', '33000₮', '33.000₮']) {
    assert.deepEqual(numeralsNotAllowed(form, ALLOWED), [], `${form} must pass`);
  }
});

test('half a phone number is as wrong as a made-up one — this is NOT a substring test', () => {
  assert.deepEqual(numeralsNotAllowed('7741 дугаараар', ALLOWED), ['7741']);
  assert.deepEqual(numeralsNotAllowed('7741-7777 дугаараар', ALLOWED), []);
});

test('Mongolian-script digits are caught, where Number() and parseInt() both see NaN', () => {
  // ᠒᠐ is 20 in Mongolian numerals. `Number('᠓')` is NaN — verified — so a guard written
  // the obvious way treats these as "not a number" and lets an invented price straight
  // through. That is exactly the hole an injection would need.
  assert.equal(Number.isNaN(Number('᠓')), true, 'precondition: Number() sees NaN');
  assert.equal(Number.isNaN(parseInt('᠓', 10)), true, 'precondition: parseInt() sees NaN too');
  assert.equal(digitsOf('᠒᠐'), '20');
  assert.deepEqual(numeralsNotAllowed('Үнэ нь ᠒᠐,᠐᠐᠐₮.', ALLOWED), ['᠒᠐,᠐᠐᠐']);
  assert.deepEqual(numeralsNotAllowed('Үнэ нь ᠓᠓,᠐᠐᠐₮.', ALLOWED), [], '33,000 in Mongolian digits is allowed');
});

test('a space joins a thousands group but never a date and a time', () => {
  // «33 000» is ordinary Mongolian thousands grouping and must stay one numeral. But if a
  // space joined unconditionally, «2026-09-04 15:00» would fuse into one nonsense token
  // and a legitimate reply would be refused. The joiner requires exactly three digits.
  assert.deepEqual(extractNumerals('33 000₮').map((n) => n.raw), ['33 000']);
  assert.deepEqual(extractNumerals('2026-09-04 15:00').map((n) => n.raw), ['2026-09-04', '15:00']);
});

test('a hyphenated number stays one token; a hyphenated TIME RANGE is two', () => {
  // The dash join is right for a phone number, whose halves are individually meaningless,
  // and wrong for a time range, whose halves are two facts the tenant approved separately.
  // This test used to assert `10:00-20:00` reduced to `10002000` — describing the defect
  // rather than a requirement. That digit string cannot appear in any allow-list, so a bot
  // stating its own opening hours was refused as `outbound_price`.
  assert.deepEqual(extractNumerals('7741-7777').map((n) => n.digits), ['77417777']);
  assert.deepEqual(extractNumerals('10:00-20:00').map((n) => n.raw), ['10:00', '20:00']);
  assert.deepEqual(extractNumerals('10:00–20:00').map((n) => n.raw), ['10:00', '20:00'], 'en dash too');
  assert.deepEqual(extractNumerals('маргааш 15:00 цагт').map((n) => n.raw), ['15:00']);

  // Splitting is conservative: EVERY dash-separated part must be a clock time. A price
  // range has no colons and is untouched; a half-formed time stays fused and is therefore
  // refused, which is the safe direction.
  assert.deepEqual(extractNumerals('33,000-55,000').map((n) => n.digits), ['3300055000']);
  assert.deepEqual(extractNumerals('2026-09-04').map((n) => n.raw), ['2026-09-04']);
  assert.deepEqual(extractNumerals('10:00-20').map((n) => n.raw), ['10:00-20']);
  assert.deepEqual(extractNumerals('10-20:00').map((n) => n.raw), ['10-20:00']);
});

test('splitting a clock range can only ever refuse MORE, never less', () => {
  // The property that makes the change safe to have made at all. Each half must now be in
  // the allow-list on its own, where before one fused token had to be — so no allow-list
  // that refused a reply before can permit it now.
  assert.deepEqual(numeralsNotAllowed('10:00-20:00', ['10:00', '20:00']), []);
  // The fused token alone no longer licenses the range, because the range is not one
  // number any more.
  assert.deepEqual(numeralsNotAllowed('10:00-20:00', ['10:00-20:00']).sort(), ['10:00', '20:00']);
  // Half an approved range is refused, exactly as half a phone number is.
  assert.deepEqual(numeralsNotAllowed('10:00-20:00', ['10:00']), ['20:00']);
});

test('a reply with no numerals at all passes trivially', () => {
  assert.deepEqual(numeralsNotAllowed('Тэр үйлчилгээний үнэ надад байхгүй байна.', ALLOWED), []);
});

test('an empty allow-list refuses every numeral — a tenant with no compiled prices quotes none', () => {
  assert.deepEqual(numeralsNotAllowed('33,000₮', []), ['33,000']);
});

// ---------------------------------------------------------------------------
// The percentage tripwire — §6.5 Ш6 / §6.7 item 3.
// ---------------------------------------------------------------------------

test('the concession tripwire sees a percentage even in a fully confident sentence', () => {
  // Ш6 exists because the dangerous discount answer carries no hedge at all, so a
  // forbidden list made of hedging vocabulary misses it entirely. Promising a discount
  // that does not exist is the salon's money.
  assert.equal(containsPercentage('Тийм ээ, шинэ үйлчлүүлэгчдэд эхний удаа 10% хямдралтай.'), true);
  assert.equal(containsPercentage('10 %'), true);
  assert.equal(containsPercentage('᠑᠐%'), true, 'Mongolian digits too');
  assert.equal(containsPercentage('Хямдрал одоогоор байхгүй байна.'), false);
});

test('percentagesIn reduces each percentage to digits, keeps a decimal point, and ignores links', () => {
  assert.deepEqual(percentagesIn('Хоёр ажилтан −10%, гурав −15 %, дөрөв ба түүнээс дээш −20%.'), ['10', '15', '20']);
  assert.deepEqual(percentagesIn('᠑᠐% ба ٥٠%'), ['10', '50'], 'every decimal-digit script reduces to ASCII');
  assert.deepEqual(percentagesIn('1.5% ба 1,5%'), ['1.5', '1.5'], 'a decimal is never read as 15');
  assert.deepEqual(percentagesIn('https://example.com/a%20b?q=1%2C хаягаар'), [], 'a URL encoding is not a percentage');
  assert.deepEqual(percentagesIn('Хямдрал байхгүй.'), []);
  // Everything containsPercentage flags outside a link, this returns: the tripwire's
  // coverage did not shrink when it learned to name the figure.
  for (const t of ['10%', '10 %', '᠑᠐%', 'a 7% b', '−20%']) {
    assert.equal(containsPercentage(t), percentagesIn(t).length > 0, t);
  }
});

test('tenantPercentages keeps the tenant’s own percentages and drops the gate’s counter-examples', () => {
  // Ш6 quotes «10% хямдралтай» as the answer it forbids. A tenant whose only 10% is that
  // one gets nothing; a tenant whose own FAQ also says 10% keeps it (multiset, not set).
  const gate = 'Буруу хариулт: «Тийм ээ, шинэ үйлчлүүлэгчдэд эхний удаа 10% хямдралтай.»';
  const tenantFaq = 'Хоёр ажилтан −10%, гурав −15%, дөрөв ба түүнээс дээш −20%. Вэбсайт: гэрээ байгуулахад 50%, хүлээлгэн өгөхөд 50%.';
  assert.deepEqual(tenantPercentages(`${gate}\n\n${tenantFaq}`, gate), ['10', '15', '20', '50']);
  assert.deepEqual(tenantPercentages(`${gate}\n\nҮс засалт 33,000₮`, gate), [], 'the gate alone approves nothing');
  assert.deepEqual(tenantPercentages(`${gate}\n\n${tenantFaq}`, null), [], 'a snapshot that cannot be split approves nothing');
});

// ---------------------------------------------------------------------------
// URLs — §6.7 item 1.
// ---------------------------------------------------------------------------

const ALLOWED_URLS = ['https://www.matrixecosalon.org/'];

test('the tenant\'s own booking link passes, in every ordinary punctuation context', () => {
  for (const reply of [
    'Та https://www.matrixecosalon.org/ хаягаар захиалаарай.',
    'Захиалга: https://www.matrixecosalon.org/.',
    'Дэлгэрэнгүйг (https://www.matrixecosalon.org/) үзнэ үү.',
    'www.matrixecosalon.org руу орно уу.',
  ]) {
    assert.deepEqual(urlsNotAllowed(reply, ALLOWED_URLS), [], reply);
  }
});

test('a link the tenant never declared is reported, raw, exactly as emitted', () => {
  assert.deepEqual(
    urlsNotAllowed('Энд дарна уу https://evil.example/pay', ALLOWED_URLS),
    ['https://evil.example/pay'],
  );
});

test('a look-alike host does not pass — canonicalisation compares hosts, not prefixes', () => {
  assert.deepEqual(
    urlsNotAllowed('https://www.matrixecosalon.org.evil.example/', ALLOWED_URLS).length,
    1,
  );
});

test('the scheme is kept, so an allow-listed https entry never licenses http', () => {
  // Folding the two together would let an injected downgrade ride an entry the tenant
  // approved for the secure form only.
  assert.deepEqual(urlsNotAllowed('http://www.matrixecosalon.org/', ALLOWED_URLS).length, 1);
});

test('canonicalisation is case- and trailing-slash-insensitive on the parts where that is safe', () => {
  assert.equal(canonicalizeUrl('https://WWW.MatrixEcoSalon.org/'), 'https://www.matrixecosalon.org');
  assert.equal(canonicalizeUrl('https://www.matrixecosalon.org'), 'https://www.matrixecosalon.org');
  assert.equal(canonicalizeUrl('https://www.matrixecosalon.org/book?ref=fb'),
    'https://www.matrixecosalon.org/book?ref=fb', 'the query is part of the identity');
});

test('an unparseable or non-http link is refused, never passed through', () => {
  assert.equal(canonicalizeUrl('http://'), null);
  assert.equal(canonicalizeUrl('javascript:alert(1)'), null);
  assert.equal(canonicalizeUrl('not a url at all'), null);
});

test('extractUrls trims the sentence punctuation that is not part of the link', () => {
  assert.deepEqual(extractUrls('Үзнэ үү: https://a.example/x, дараа нь.'), ['https://a.example/x']);
  assert.deepEqual(extractUrls('«https://a.example/x»'), ['https://a.example/x']);
});

// --- a URL is checked as a URL; its digits are never numerals (D-074) ------------------

/** Matrix's real location, and the `9` in its slug is the whole story. */
const MAPS = 'https://maps.app.goo.gl/fHaBVwc9mFZJxYAJ9';

test('DONE-TEST: A URL SLUG IS NOT A PRICE', () => {
  // Found by two bugs cancelling. Compiling this link into a rendered section put `9` into
  // `allowed_numbers` — a numeral no human approved — and a reply quoting the link carried
  // the same `9`, which passed only because the allow-list had been widened by that very
  // slug. Remove either alone and the salon's own location reads as an invented price.
  assert.deepEqual(extractNumerals(MAPS).map((n) => n.raw), ['9', '9'], 'the slug really does carry digits');
  assert.deepEqual(numeralsNotAllowed(`Манай байршил: ${MAPS}`, []), [], 'and none of them is a numeral');
});

test('DONE-TEST: and the check with an EMPTY allow-list is the half nothing could save', () => {
  // Check 2b is passed no allow-list at all on a refused topic, so no accidental widening
  // could ever have rescued it: quoting the location in a reply about children's services
  // was refused as a price. That one was broken independently of the leak.
  assert.deepEqual(numeralsNotAllowed(MAPS, []), []);
});

test('a real numeral beside a link is still caught', () => {
  // The masking must not become a hiding place. Text outside the link is unaffected.
  assert.deepEqual(numeralsNotAllowed(`Үнэ 45,000₮. Дэлгэрэнгүй: ${MAPS}`, []), ['45,000']);
  assert.deepEqual(numeralsNotAllowed(`Үнэ 45,000₮. Дэлгэрэнгүй: ${MAPS}`, ['45,000']), []);
});

test('masking replaces a link with a SPACE, never with nothing', () => {
  // Splicing the sides together would manufacture a numeral that was never written — the
  // mistake `disclosesPrompt` documents on its own corpus, in a different file.
  assert.equal(maskUrls('1https://x.example/a2'), '1 ');
  assert.deepEqual(extractNumerals(maskUrls('1https://x.example/a2')).map((n) => n.raw), ['1']);
});

test('a bare www link is masked too, as extractUrls finds it', () => {
  // One regex, shared, so the two cannot drift about what a link is.
  assert.equal(maskUrls('очно уу www.matrixecosalon.org/9 гэж').trim(), 'очно уу   гэж'.trim());
  assert.deepEqual(numeralsNotAllowed('www.matrixecosalon.org/9', []), []);
});
