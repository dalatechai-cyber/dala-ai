#!/usr/bin/env node
// GUARD: one phone number must not appear anywhere in this repository, in any spelling.
//
// It was given to a visitor by the website chatbot once, is not a contact detail DalaTech
// publishes, and had spread into old prompts, docs and templates. The decision (founder,
// 2026-09-29) is to leave it out entirely, not to replace it. A tenant's own contact
// numbers are data rows; a chatbot only states a phone number that a row holds
// (guard/facts.ts, D-120). This guard covers the other half: no file we ship or write may
// carry it, so it cannot be copied back into a prompt, a fixture or a template.
//
// The number is assembled from four pairs so this file does not contain it. Do not
// "simplify" that into a literal: the guard would then fail on itself.
import fs from 'node:fs';
import path from 'node:path';
import { fail } from './_walk.mjs';

const PAIRS = ['99', '27', '33', '39'];
const SEP = '[\\s\\u00a0\\-\\u2010-\\u2015.()/_]{0,3}';
// Each pair may itself be split: 9-9-2-7… is the same number. No digit may touch either end.
const digits = PAIRS.join('').split('');
const RUN = new RegExp(`(?<![0-9])${digits.join(SEP)}(?![0-9])`, 'u');

const SKIP = new Set(['node_modules', '.next', '.git', 'coverage', 'dist', 'build', '.vercel']);
const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|docx|xlsx|pptx|woff2?|ttf|otf|zip|gz|mp[34])$/i;

function* files(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* files(full);
    else if (!BINARY.test(e.name)) yield full;
  }
}

const problems = [];
for (const file of files('.')) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { problems.push(`${file}: unreadable`); continue; }
  if (text.includes('\0')) continue;
  const flat = text.normalize('NFC');
  const m = RUN.exec(flat);
  if (m) {
    const line = flat.slice(0, m.index).split('\n').length;
    problems.push(`${file}:${line} contains the banned phone number. Remove it; do not replace it.`);
  }
}
fail('no banned phone number in the repository', problems);
