#!/usr/bin/env node
// GUARD: the platform's own Mongolian carries a native-speaker sign-off, and the
// signature is over the text that will actually ship. (§6.6.)
//
// The schema already refuses to render a `canned_responses` row whose `reviewed_at` is
// null. The draft put that gate on TENANT rows only and left the platform blocks covered
// by code review — by people who do not read Mongolian. Three errors were already present
// in the draft's own platform text and were caught only by an adversarial read; the worst
// of them, «дага БҮҮ дага», was a duplicated verb in the one sentence whose entire job is
// to stop the model following instructions pasted into a tenant's knowledge base.
//
// So the signature is over the FILE HASH, not the filename. Editing a block after
// sign-off invalidates it, which is the case this guard exists to catch: a block changed
// in a hurry, shipped unreviewed, and read by customers.
//
// This is a process gate, not a cryptographic one — someone can paste a hash they did not
// earn. What it makes impossible is the accidental version, which is the one that happens.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fail } from './_walk.mjs';

const DIR = 'prompt/platform';
const SIGNOFF = 'prompt/platform-mn-review.json';
const problems = [];

let signoff = { blocks: [] };
if (!fs.existsSync(SIGNOFF)) {
  problems.push(`${SIGNOFF} is missing. The platform's Mongolian has nowhere to be signed off.`);
} else {
  try {
    signoff = JSON.parse(fs.readFileSync(SIGNOFF, 'utf8'));
  } catch (err) {
    problems.push(`${SIGNOFF} is not valid JSON: ${err.message}`);
  }
}

const blocks = Array.isArray(signoff.blocks) ? signoff.blocks : [];
const byId = new Map();
for (const b of blocks) {
  if (typeof b?.block_id !== 'string' || b.block_id === '') {
    problems.push(`${SIGNOFF}: an entry has no block_id.`);
    continue;
  }
  if (byId.has(b.block_id)) {
    problems.push(`${SIGNOFF}: two sign-offs for "${b.block_id}". Which one is current is then a guess.`);
  }
  byId.set(b.block_id, b);
}

const files = fs.existsSync(DIR)
  ? fs.readdirSync(DIR).filter((f) => f.endsWith('.mn.txt')).sort()
  : [];

for (const file of files) {
  const blockId = file.slice(0, -'.mn.txt'.length);
  const raw = fs.readFileSync(path.join(DIR, file), 'utf8');

  // NFC at every boundary (CLAUDE.md rule 6). The schema's `check (body is normalized)`
  // would reject an NFD file at seed time; catching it here names the file instead of
  // failing a migration with a constraint violation.
  if (raw.normalize('NFC') !== raw) {
    problems.push(`${DIR}/${file} is not NFC-normalised. Ё and Й decompose; the seed's normalized CHECK will reject it.`);
  }
  if (raw.trim() === '') {
    problems.push(`${DIR}/${file} is empty. An empty platform block is a rendering hole, not a no-op.`);
  }

  const sha = createHash('sha256').update(raw, 'utf8').digest('hex');
  const entry = byId.get(blockId);

  if (entry === undefined) {
    problems.push(
      `${DIR}/${file} has no sign-off in ${SIGNOFF}.\n` +
      `      A native speaker must read it and add:\n` +
      `      { "block_id": "${blockId}", "sha256": "${sha}", "reviewed_by": "<name>", "reviewed_at": "<ISO date>" }`);
    continue;
  }
  if (entry.sha256 !== sha) {
    problems.push(
      `${DIR}/${file} has CHANGED since it was signed off.\n` +
      `      signed: ${entry.sha256}\n` +
      `      actual: ${sha}\n` +
      `      Signed off by ${entry.reviewed_by ?? '<nobody>'} on ${entry.reviewed_at ?? '<never>'}. It needs re-reading, not a hash update.`);
  }
  for (const field of ['reviewed_by', 'reviewed_at']) {
    if (typeof entry[field] !== 'string' || entry[field] === '') {
      problems.push(`${SIGNOFF}: "${blockId}" has no ${field}. An unattributed sign-off is not one.`);
    }
  }
}

for (const blockId of byId.keys()) {
  if (!files.includes(`${blockId}.mn.txt`)) {
    problems.push(
      `${SIGNOFF} signs off "${blockId}", but ${DIR}/${blockId}.mn.txt does not exist.\n` +
      `      A stale signature makes the next block to take that name look reviewed.`);
  }
}

fail('check-mn-review', problems);
