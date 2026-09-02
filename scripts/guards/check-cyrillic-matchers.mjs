#!/usr/bin/env node
// GUARD: customer text is Mongolian Cyrillic. (CLAUDE.md rule 6.)
//
// \b and \w are ASCII-word-boundary constructs. Against «Хүүхдийн үс» they do not mean
// what they appear to mean, and the failure is silent: the matcher simply never fires,
// or fires in the wrong place. [a-z] over user text is the same mistake spelled
// differently. Byte length is not character length in UTF-8 Cyrillic.
//
// The rule is narrow on purpose. These constructs are fine over ASCII identifiers —
// header names, env keys, hex digests — so the guard only fires on files that also
// touch user-supplied text, and any single line may opt out with an explicit
// `// ascii-safe:` justification.
import fs from 'node:fs';
import { walk, stripComments, fail } from './_walk.mjs';

const TEXT_HINTS = /\b(message|reply|body\.text|userText|customerText|prompt|caption|conversation)\b/i;
const problems = [];

for (const file of walk('src')) {
  const raw = fs.readFileSync(file, 'utf8');
  const src = stripComments(raw);
  if (!TEXT_HINTS.test(src)) continue;

  const rawLines = raw.split('\n');
  src.split('\n').forEach((line, i) => {
    const lineNo = i + 1;
    if (/ascii-safe:/.test(rawLines[i] ?? '')) return;
    const checks = [
      [/\\b/, '\\b — an ASCII word boundary; it does not delimit Cyrillic words'],
      [/\\w/, '\\w — ASCII word characters only; it excludes every Cyrillic letter'],
      [/\[a-z[^\]]*\]/i, '[a-z] — an ASCII range; Cyrillic never matches it'],
      [/\.length\s*[<>]=?\s*\d+\s*\)?\s*(?:\/\/.*)?$/, 'a raw .length comparison — in UTF-8 Cyrillic, byte length is not character length'],
    ];
    for (const [re, why] of checks) {
      if (re.test(line)) {
        problems.push(
          `${file}:${lineNo} uses ${why}.\n` +
          `      If this really is over ASCII (a header, an id, a hex digest), append ` +
          `\`// ascii-safe: <reason>\` to the line.`);
      }
    }
  });
}

fail('check-cyrillic-matchers', problems);
