#!/usr/bin/env node
// Measures what Reception pays for on every message, by section.
//
// This exists because the composition figure is a commercial argument — it is
// what says the margin-recovery path in docs/prefix-trim.md is worth doing —
// and a commercial argument should be re-runnable, not retyped. Two documents
// in this repo once carried two different answers for the same prefix because
// the number was typed by hand twice.
//
// NOT A CI TEST, deliberately. It reads the real prefix out of the ancestor
// checkout, and the ancestor is private, so a CI step that needs it fails to
// clone and skips green — that exact bug already happened once here. Anything
// that must gate CI belongs in test/ with a synthetic fixture.
//
//   node scripts/bakeoff/compose.mjs [--ancestor <path>] [--markdown]
import { buildMatrixPrefix, DEFAULT_ANCESTOR } from './prefix.mjs';

// Every section the ancestor emits, classified. Unclassified is a hard error
// rather than an "other" bucket: silently dropping a section is precisely how
// the deposit rule (544 chars of tenant knowledge) went missing from the first
// measurement and made tenant knowledge look 6 points smaller than it is.
const CLASS = new Map([
  ['(preamble)',                          'platform'],
  ['ХЭЛНИЙ ДҮРЭМ',                        'platform'],
  ['ХАРИУЛАХ ЗААВАР',                     'platform'],
  ['ҮНИЙН МЭДЭЭЛЭЛ ӨГӨХ ДҮРЭМ',           'platform'],
  ['СУВГИЙН ЗААВАР (Facebook Messenger)',  'platform'],
  ['ХЭЛНИЙ ЧАНАРЫН ХАТУУ ДҮРЭМ',          'platform'],
  ['КОМПАНИЙН ТАНИЛЦУУЛГА',               'tenant'],
  ['МАНАЙ БАГ',                           'tenant'],
  ['ҮНИЙН ЖАГСААЛТ',                      'tenant'],
  ['ҮНИЙН ЖАГСААЛТЫН САН НӨӨЦ',           'tenant'],
  ['ТҮГЭЭМЭЛ АСУУЛТ',                     'tenant'],
  ['ХОЛБОО БАРИХ МЭДЭЭЛЭЛ',               'tenant'],
  ['УРЬДЧИЛГАА ТӨЛБӨРИЙН ДҮРЭМ (цаг авах үед)', 'tenant'],
  ['ЖИШЭЭ ЯРИ',                           'examples'],
]);

export function compose(prefix) {
  // The ancestor's own delimiter. Section text runs to the next delimiter, so
  // every character of the prefix lands in exactly one section — including the
  // delimiter lines themselves, which are real tokens we really pay for.
  const marks = [...prefix.matchAll(/^=== (.+?) ===$/gm)]
    .map((m) => ({ title: m[1], start: m.index }));
  if (marks.length === 0) throw new Error('no section delimiters found — the ancestor has changed shape');

  const sections = [];
  if (marks[0].start > 0) sections.push({ title: '(preamble)', chars: marks[0].start });
  marks.forEach((mk, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].start : prefix.length;
    sections.push({ title: mk.title, chars: end - mk.start });
  });

  const unknown = sections.filter((s) => !CLASS.has(s.title)).map((s) => s.title);
  if (unknown.length) {
    throw new Error(
      `unclassified section(s): ${unknown.join(', ')}\n` +
      `Add each to CLASS in this file. Do not bucket them as "other" — an ` +
      `unclassified section silently understates whichever total it belongs to.`);
  }

  const total = prefix.length;
  const byClass = { platform: 0, tenant: 0, examples: 0 };
  for (const s of sections) {
    s.class = CLASS.get(s.title);
    s.share = (100 * s.chars) / total;
    byClass[s.class] += s.chars;
  }
  sections.sort((a, b) => b.chars - a.chars);

  const sum = sections.reduce((n, s) => n + s.chars, 0);
  if (sum !== total) throw new Error(`sections sum to ${sum}, prefix is ${total} — a section was lost`);

  return { total, sections, byClass };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--ancestor');
  const ancestor = at === -1 ? DEFAULT_ANCESTOR : argv[at + 1];
  const markdown = argv.includes('--markdown');

  const prefix = await buildMatrixPrefix(ancestor);
  if (prefix.normalize('NFC') !== prefix) throw new Error('prefix is not NFC-normalised');
  const { total, sections, byClass } = compose(prefix);

  const n = (x) => x.toLocaleString('en-US');
  const pct = (x) => `${((100 * x) / total).toFixed(1)}%`;

  if (markdown) {
    console.log('| Section | chars | share | class |');
    console.log('|---|---:|---:|---|');
    for (const s of sections) {
      const t = s.class === 'tenant' ? `**tenant**` : s.class;
      console.log(`| ${s.title} | ${n(s.chars)} | ${pct(s.chars)} | ${t} |`);
    }
    console.log();
    console.log(`**platform ${n(byClass.platform)} (${pct(byClass.platform)}) · ` +
                `tenant ${n(byClass.tenant)} (${pct(byClass.tenant)}) · ` +
                `examples ${n(byClass.examples)} (${pct(byClass.examples)})** ` +
                `of ${n(total)} characters.`);
  } else {
    for (const s of sections) {
      console.log(String(n(s.chars)).padStart(7), pct(s.chars).padStart(6), s.class.padEnd(9), s.title);
    }
    console.log('-'.repeat(52));
    for (const k of ['platform', 'tenant', 'examples']) {
      console.log(String(n(byClass[k])).padStart(7), pct(byClass[k]).padStart(6), k);
    }
    console.log(String(n(total)).padStart(7), '  100%', 'TOTAL (every character classified)');
  }
}
