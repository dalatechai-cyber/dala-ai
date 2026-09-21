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
import { createHash } from 'node:crypto';
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

/**
 * Which ancestor produced a reply, recorded per entry.
 *
 * The ancestor stopped being a fixed baseline the moment the founder asked for two fixes
 * in it (stop praising Мастер, stop raw markdown). A capture that mixes pre- and post-fix
 * replies without saying which is which would put two different bots in one column of the
 * comparison table, and the reader could not tell. This is the file's own content hash,
 * so it changes exactly when the prompt does.
 */
const ancestorPrompt = (() => {
  // BOTH files, because both shape the reply and only hashing one under-reports.
  // Measured: changing the Maps link in `currentClient.js` altered what the ancestor
  // says and left a salonBrain-only hash identical, so two different ancestors would
  // have carried one stamp — the exact confusion the stamp exists to prevent.
  const h = createHash('sha256');
  for (const f of ['lib/salonBrain.js', 'config/currentClient.js']) {
    h.update(readFileSync(`/home/user/Matrix-Chatbot/${f}`));
  }
  return h.digest('hex').slice(0, 12);
})();
process.stdout.write(`ancestor: prompt+knowledge ${ancestorPrompt}\n`);

const set = JSON.parse(readFileSync('scripts/bakeoff/testset.json', 'utf8'));

let calls = 0;

/** One call, timed, with the failure captured rather than thrown. */
async function ask(message, history) {
  calls += 1;
  const started = Date.now();
  try {
    const reply = await generateSalonReply({ message, history });
    const text = typeof reply === 'string' ? reply : (reply?.text ?? reply?.reply ?? JSON.stringify(reply));
    return { ok: true, reply: text, ms: Date.now() - started };
  } catch (e) {
    // A failure is DATA: "the ancestor errored here" is a real comparison result, and
    // throwing would lose every reply captured before it.
    return { ok: false, reply: null, error: e instanceof Error ? e.message : String(e), ms: Date.now() - started };
  }
}

// No model id recorded: the ancestor chooses its own in `lib/salonBrain.js`, and a copy
// here would be a second place to update — the drift §6.2.6 exists to prevent.
/**
 * `--only` MERGES into the capture on disk. It must never start from an empty object.
 *
 * It did, and the consequence was not hypothetical: re-running `--only f13` to verify the
 * founder's ancestor fix wrote a file with one single and ZERO conversations, discarding
 * the eleven-turn thread the brief says to capture once and never re-ask. Nothing was lost
 * only because the previous capture was already committed — the recovery was `git
 * checkout`, not a re-run, so no budget was spent twice. A selective re-run that silently
 * deletes what it did not select destroys the evidence it exists to preserve, and the
 * report built on it would have shown a whole section vanishing between runs.
 */
const prior = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null;
if (only !== null && prior === null) {
  process.stderr.write('--only merges into an existing capture, and none exists. Run the full capture first.\n');
  process.exit(3);
}

// Seeded from the prior capture so a selective re-run ADDS to it. See the note on `prior`.
const out = {
  capturedAt: new Date().toISOString(),
  singles: { ...(prior?.singles ?? {}) },
  conversations: { ...(prior?.conversations ?? {}) },
};
const wanted = (id) => only === null || only.split(',').includes(id);

for (const c of set.cases) {
  if (!wanted(c.id)) continue;
  const r = await ask(c.text, []);
  out.singles[c.id] = { text: c.text, ...r, ancestorPrompt };
  process.stdout.write(`  ${c.id}  ${String(r.ms).padStart(6)}ms  ${r.ok ? `${r.reply.length} chars` : `ERROR ${r.error}`}\n`);
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
    ? { text: c.text, ok: true, reply: null, silent: true, ms: 0 }
    : { text: c.text, ok: true, reply: buildImageResponse(), ms: 0, deterministic: true };
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
    if (r.ok) history.push({ role: 'assistant', content: r.reply });
    process.stdout.write(`  ${conv.id}  ${String(r.ms).padStart(6)}ms  ${r.ok ? `${r.reply.length} chars` : `ERROR ${r.error}`}\n`);
  }
  out.conversations[conv.id] = { note: conv.note, turns, ancestorPrompt };
}

writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
// Calls made BY THIS RUN, not entries in the merged file. Counting the file was correct
// only while every run was a full capture; once `--only` merges, it reports the whole
// baseline as though it had just been re-asked — a `--only f13` run printed "43 model
// call(s)" having made one. The founder tracks a budget against this line, so a number
// that overstates spend by 43x is worse than no number.
process.stdout.write(`\nwrote ${OUT} — ${calls} model call(s) THIS RUN. Re-running needs --force.\n`);
