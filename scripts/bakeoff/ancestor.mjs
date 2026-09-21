/**
 * Capture the ANCESTOR's reply to every test message, once, and save it.
 *
 *     ANTHROPIC_API_KEY=… node scripts/bakeoff/ancestor.mjs
 *
 * ## It runs the incumbent's own code
 *
 * It imports `generateSalonReply` from `Matrix-Chatbot/lib/salonBrain.js` — the same
 * function, the same `config/currentClient.js` knowledge, the same `claude-sonnet-5`, the
 * same 1h cached system prompt that answers Matrix's real customers today. Nothing about
 * the baseline is reimplemented here, because a reimplementation would be measuring this
 * file rather than the bot we are trying to match.
 *
 * ## IT NEVER TOUCHES MESSENGER
 *
 * `generateSalonReply` calls Anthropic and returns text. The send path
 * (`messengerClient.js`) is not imported and no PSID exists in this process, so there is no
 * code path from here to the salon's inbox. That is a property of what is imported, not a
 * promise — real conversations on that Page go to the salon, and a test message landing
 * there would be a stranger writing to their customers.
 *
 * ## Captured ONCE
 *
 * The ancestor is a fixed baseline: it is not being changed tonight, so its answers cannot
 * change. Re-asking would spend the founder's budget to reproduce a file that is already on
 * disk. The script refuses to overwrite an existing capture unless `--force` is passed.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const OUT = 'scripts/bakeoff/baseline-ancestor.json';
const force = process.argv.includes('--force');
const only = (() => { const i = process.argv.indexOf('--only'); return i === -1 ? null : process.argv[i + 1]; })();

if (existsSync(OUT) && !force && only === null) {
  process.stderr.write(
    `${OUT} already exists.\n` +
    'The ancestor is a FIXED baseline — it is not being changed, so re-asking it spends\n' +
    "money to reproduce a file you already have. Pass --force if you genuinely mean to.\n");
  process.exit(1);
}
if (!process.env['ANTHROPIC_API_KEY']) {
  process.stderr.write('ANTHROPIC_API_KEY is not set. Nothing was called and nothing was spent.\n');
  process.exit(2);
}

const { generateSalonReply, SALON_NAME } = await import('/home/user/Matrix-Chatbot/lib/salonBrain.js');
process.stdout.write(`ancestor: knowledge loaded for "${SALON_NAME}"\n`);

const set = JSON.parse(readFileSync('scripts/bakeoff/testset.json', 'utf8'));

/** One call, timed, with the failure captured rather than thrown. */
async function ask(message, history) {
  const started = Date.now();
  try {
    const reply = await generateSalonReply({ message, history });
    const text = typeof reply === 'string' ? reply : (reply?.text ?? reply?.reply ?? JSON.stringify(reply));
    return { ok: true, text, ms: Date.now() - started };
  } catch (e) {
    // A failure is DATA: "the ancestor errored here" is a real comparison result, and
    // throwing would lose every reply captured before it.
    return { ok: false, text: null, error: e instanceof Error ? e.message : String(e), ms: Date.now() - started };
  }
}

const out = { capturedAt: new Date().toISOString(), model: 'claude-sonnet-5', singles: {}, conversations: {} };
const wanted = (id) => only === null || only.split(',').includes(id);

for (const c of set.cases) {
  if (!wanted(c.id)) continue;
  const r = await ask(c.text, []);
  out.singles[c.id] = { text: c.text, ...r };
  process.stdout.write(`  ${c.id}  ${String(r.ms).padStart(6)}ms  ${r.ok ? `${r.text.length} chars` : `ERROR ${r.error}`}\n`);
}

// The attachment cases go through the ancestor's own image shortcut, which answers WITHOUT
// calling the model — so they cost nothing and must not be sent to the brain, or the
// baseline would record a model reply the real bot never produces for a photo.
const { buildImageResponse } = await import('/home/user/Matrix-Chatbot/lib/salonIntents.js');
for (const c of set.attachmentCases) {
  if (!wanted(c.id)) continue;
  const sticker = Array.isArray(c.stickerIds) && c.stickerIds.length > 0;
  out.singles[c.id] = sticker
    // The ancestor drops a sticker before any reply is built.
    ? { text: c.text, ok: true, text_reply: null, silent: true, ms: 0 }
    : { text: c.text, ok: true, text: buildImageResponse(), ms: 0, deterministic: true };
  process.stdout.write(`  ${c.id}  deterministic (no model call, no spend)\n`);
}

// The multi-turn thread, carried the way the ancestor carries it: each reply is appended to
// history before the next question. The whole point of the comparison is what the bot does
// with a conversation, so replaying the turns independently would measure the wrong thing.
for (const conv of set.conversations) {
  if (only !== null && !wanted(conv.id)) continue;
  const history = [];
  const turns = [];
  for (const t of conv.turns) {
    const r = await ask(t, history);
    turns.push({ text: t, ...r });
    history.push({ role: 'user', content: t });
    if (r.ok) history.push({ role: 'assistant', content: r.text });
    process.stdout.write(`  ${conv.id}  ${String(r.ms).padStart(6)}ms  ${r.ok ? `${r.text.length} chars` : `ERROR ${r.error}`}\n`);
  }
  out.conversations[conv.id] = { note: conv.note, turns };
}

writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
const calls = Object.values(out.singles).filter((s) => !s.deterministic && !s.silent).length
  + Object.values(out.conversations).reduce((n, c) => n + c.turns.length, 0);
process.stdout.write(`\nwrote ${OUT} — ${calls} model call(s). Re-running needs --force.\n`);
