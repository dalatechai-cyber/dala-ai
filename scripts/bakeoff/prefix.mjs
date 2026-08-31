// Builds the REAL Matrix Reception prefix from the ancestor checkout.
//
// It is read from Matrix-Chatbot rather than copied into this repo on purpose:
// a second copy of the salon's price list is a second thing that can drift, and
// the whole point of measuring is to measure what production actually sends.
//
// MESSENGER_ADDENDUM is module-local in the ancestor and interpolates several of
// its own constants, so it cannot be imported directly. The cheapest correct way
// to get its rendered value is to import a copy of the module with that one
// binding exported. The copy is written next to the original so its relative
// imports still resolve, and is removed again in a finally block.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_ANCESTOR = '/home/user/Matrix-Chatbot';

export async function buildMatrixPrefix(ancestorDir = DEFAULT_ANCESTOR) {
  if (!fs.existsSync(ancestorDir)) {
    throw new Error(
      `Ancestor checkout not found at ${ancestorDir}.\n` +
      `Clone it next to this repo, or pass --ancestor <path>:\n` +
      `  git clone https://github.com/dalatechai-cyber/Matrix-Chatbot`);
  }

  const brainPath = path.join(ancestorDir, 'lib', 'salonBrain.js');
  const tmpPath   = path.join(ancestorDir, 'lib', `_bakeoff_tmp_${process.pid}.mjs`);
  if (!fs.existsSync(brainPath)) throw new Error(`Not the ancestor repo: ${brainPath} is missing`);

  try {
    const src = fs.readFileSync(brainPath, 'utf8');
    const patched = src.replace(/^const MESSENGER_ADDENDUM = `/m, 'export const MESSENGER_ADDENDUM = `');
    if (patched === src) throw new Error('MESSENGER_ADDENDUM not found — the ancestor has changed shape');
    fs.writeFileSync(tmpPath, patched);

    const { MESSENGER_ADDENDUM } = await import(pathToFileURL(tmpPath).href);
    const { buildSystemPrompt } = await import(pathToFileURL(path.join(ancestorDir, 'lib', 'systemPromptBuilder.js')).href);
    const { clientData }        = await import(pathToFileURL(path.join(ancestorDir, 'config', 'currentClient.js')).href);

    const base = await buildSystemPrompt(clientData);
    return `${base}${MESSENGER_ADDENDUM}`;
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
}

export function describe(text) {
  const cyrillic = (text.match(/[Ѐ-ӿ]/g) || []).length;
  return {
    chars: text.length,
    bytes: Buffer.byteLength(text, 'utf8'),
    cyrillicPct: Math.round((100 * cyrillic) / text.length),
  };
}
