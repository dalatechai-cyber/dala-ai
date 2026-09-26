/**
 * Compile and publish one tenant's configuration, through the code the reply path uses.
 *
 *     # dry run — compiles, prints the artefact and the diff, writes NOTHING
 *     NEXT_PUBLIC_SUPABASE_URL=… SUPABASE_SECRET_PUBLISH=… \
 *       node scripts/publish/tenant.ts --slug matrix-eco-salon
 *
 *     # and then, having read that
 *     … node scripts/publish/tenant.ts --slug matrix-eco-salon --publish
 *
 * ## Why this exists
 *
 * `compileAndPublish` needs a service-role key, and until now no environment that had one
 * could run it — so every publish since D-051 has been hand-written SQL that rebuilds the
 * compiler's output in another language. That is a second implementation of the thing the
 * request path reads, and this repository's whole catalogue of incidents is second
 * implementations disagreeing: two orderings (D-026), two calendars (D-053), two parsers
 * (D-057), two sources of one canned line (D-058).
 *
 * The SQL route was checked hard each time — hashes compared, splices inverted, invariants
 * re-asserted inside the transaction — and it still carried a live trap: `btrim()` strips
 * only U+0020 while JavaScript's `.trim()` strips every Unicode whitespace character, so a
 * canned body with a trailing tab would have hashed differently on the two sides and 503'd
 * every reply. It was clean by luck, not by construction. This command removes the class.
 *
 * ## The key is an argument to the shell, never to this process
 *
 * Read from the environment by `supabasePublish()`, never from a flag: command lines are
 * visible in `ps` to every process on the box and land in shell history. Nothing here
 * prints it, and the summary below is safe to paste.
 *
 * ## Dry run by DEFAULT
 *
 * The compiled prefix is the prompt-cache key and the text a customer is answered from, so
 * "what would change" has to be readable before anything moves. `--publish` is the only way
 * to write, and even then the draft revision is created inside the same run so a half-built
 * revision cannot be left behind by a compile that refuses.
 */
import { compileAndPublish, compileStablePrefix } from '../../src/lib/prompt/sections.ts';
import { comparePlatformBlocks, type LiveBlock } from '../prompt/blockset.ts';
import { loadLiveSnapshot } from '../../src/lib/prompt/publish.ts';
import { supabasePublish } from '../../src/lib/supabase/clients.ts';
import { SECTION_LABELS } from '../../src/lib/prompt/tenant.ts';
import { CLARIFY_BRANCH_KIND, branchNamesFromPrefix } from '../../src/lib/branches/branches.ts';
import { caseModelSeat, gateTenant, renderGate } from '../../src/lib/replycases/run.ts';
import { callReception } from '../../src/lib/model/reception.ts';

function die(message: string): never {
  process.stderr.write(`publish: ${message}\n`);
  process.exit(2);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

if (process.argv.some((a) => a.startsWith('--key') || a.startsWith('--secret'))) {
  die('the key is read from SUPABASE_SECRET_PUBLISH in the environment, never from an argument');
}

const slug = arg('slug') ?? '';
if (!/^[a-z0-9-]{1,64}$/.test(slug)) die('--slug is required, e.g. --slug matrix-eco-salon');
const doPublish = process.argv.includes('--publish');

const db = supabasePublish();
const now = new Date();

// ---- who, and on which channels ------------------------------------------
const { data: tenantRow, error: tenantErr } = await db
  .from('tenants').select('id, slug, display_name, live_revision_id').eq('slug', slug).maybeSingle();
if (tenantErr) die(`tenants unreadable: ${tenantErr.message}`);
if (tenantRow === null) die(`no tenant with slug ${slug}`);
const tenantId = String((tenantRow as Record<string, unknown>)['id']);

const { data: channelRows, error: channelErr } = await db
  .from('tenant_channels').select('provider').eq('tenant_id', tenantId);
if (channelErr) die(`tenant_channels unreadable: ${channelErr.message}`);
// THE CHANNEL IS THE TENANT'S OWN, never a literal. Writing 'messenger' by hand once
// produced a snapshot that existed, looked published, and answered `no_snapshot` for every
// reply — and `config_snapshots` is append-only, so it could only be out-appended.
const channels = [...new Set((channelRows ?? []).map((r) => String((r as Record<string, unknown>)['provider'])))];
if (channels.length === 0) die('this tenant has no channels; a revision with no channel cannot render a reply');

// ---- what is live now ----------------------------------------------------
const live = await loadLiveSnapshot(db, { tenantId, channel: channels[0] as string });
const before = live.ok ? live.snapshot : null;

// ---- what a publish WOULD produce ----------------------------------------
// ---- the platform blocks this project is actually serving --------------
//
// The ONLY check in this repository that reads the live project rather than a database CI
// built out of the repo. CI applies every migration from `supabase/migrations/`, so it is
// structurally incapable of noticing that one was never pushed (D-058) — and this command
// is the one place holding both the checkout and a service key, on the only path that can
// change what a customer reads.
//
// Publishing with a block missing would freeze that absence into the tenant's prefix, and
// the run would print «byte-identical to the live one. Nothing to publish» — which is
// exactly what a silently-missing block produces. That sentence is only true with this
// check ahead of it.
const { data: blockRows, error: blockErr } = await db
  .from('prompt_blocks')
  .select('block_key, ordinal, layer, body, reviewed_by, reviewed_at, vertical')
  .eq('scope', 'platform')
  .is('tenant_id', null);
if (blockErr) die(`prompt_blocks unreadable: ${blockErr.message}`);
const gaps = comparePlatformBlocks((blockRows ?? []) as unknown as LiveBlock[]);
if (gaps.length > 0) {
  die(
    `the LIVE platform blocks are not the signed ones. Publishing would freeze this\n`
    + `difference into ${slug}'s prefix:\n  ${gaps.join('\n  ')}\n\n`
    + `Push the seed migration, then read the ledger:\n`
    + `  select count(*), max(version) from supabase_migrations.schema_migrations;`,
  );
}
process.stdout.write(`platform blocks: ${(blockRows ?? []).length} live, matching the signed set.\n`);

const compiled = await compileStablePrefix(db, { tenantId, approvedAt: now.toISOString() });
if (!compiled.ok) {
  die(compiled.code === 'refused'
    ? `compile REFUSED (${compiled.refusal.code}): ${compiled.refusal.sections.join(', ')}`
    : `compile failed (${compiled.code}): ${compiled.detail}`);
}
const { rendered } = compiled;

const marker = `=== ${SECTION_LABELS.dataMarker} ===`;
const hadMarker = before === null ? null : before.promptStable.split('\n').some((l) => l.trim() === marker);
const hasMarker = rendered.promptStable.split('\n').some((l) => l.trim() === marker);

// Code points, because that is what `promptChars` records — `.length` counts UTF-16 units
// and would print a different number for the same text the moment anything is non-BMP.
const arrow = <T,>(from: T | null, to: T): string =>
  from === null || String(from) === String(to) ? String(to) : `${String(from)} → ${String(to)}`;

process.stdout.write(`tenant          ${slug} (${tenantId})
channels        ${channels.join(', ')}
sections        ${compiled.sectionCount}
prompt chars    ${arrow(before === null ? null : [...before.promptStable].length, rendered.promptChars)}
content_hash    ${arrow(before?.contentHash ?? null, rendered.contentHash)}
canned_hash     ${arrow(before?.cannedHash ?? null, compiled.cannedHash)}
data marker     ${arrow(hadMarker === null ? null : String(hadMarker), String(hasMarker))}
order           ${rendered.order.join(' → ')}
`);

// `allowed_numbers` is the price guarantee, so the DIFF is printed rather than the list:
// a number appearing here is a number the bot may from now on say out loud.
const oldNums = new Set(before?.allowedNumbers ?? []);
const newNums = new Set(rendered.allowedNumbers);
const added = [...newNums].filter((n) => !oldNums.has(n)).sort();
const removed = [...oldNums].filter((n) => !newNums.has(n)).sort();
process.stdout.write(`allowed_numbers ${rendered.allowedNumbers.length} token(s)`);
process.stdout.write(added.length === 0 && removed.length === 0 ? ' (unchanged)\n' : '\n');
if (added.length > 0) process.stdout.write(`  ADDED   ${added.join(', ')}  ← the bot may now state these\n`);
if (removed.length > 0) process.stdout.write(`  REMOVED ${removed.join(', ')}\n`);

if (compiled.unconfirmed.faqsExcluded.length > 0) {
  process.stdout.write(`EXCLUDED faqs   ${compiled.unconfirmed.faqsExcluded.join(', ')}\n`);
}
if (compiled.unconfirmed.refusalTopicsUnconfirmed.length > 0) {
  process.stdout.write(`UNCONFIRMED     ${compiled.unconfirmed.refusalTopicsUnconfirmed.join(', ')}\n`);
}
if (compiled.unconfirmed.branchesExcluded.length > 0) {
  process.stdout.write(`EXCLUDED branches ${compiled.unconfirmed.branchesExcluded.join(', ')}  ← not tenant_confirmed\n`);
}

// D-125, stated for the same reason as the marker below: the first compile that lists two
// or more branches changes how location, phone, hours and some prices are answered.
const branchesNow = branchNamesFromPrefix(rendered.promptStable);
const branchesBefore = before === null ? [] : branchNamesFromPrefix(before.promptStable);
if (branchesNow.join('\n') !== branchesBefore.join('\n')) {
  process.stdout.write(branchesNow.length === 0
    ? '\nNOTE: the prefix no longer lists branches. The tenant answers as one location again.\n'
    : `\nNOTE: branches ${branchesBefore.length === 0 ? 'appear for the FIRST time' : 'changed'}: ${branchesNow.join(', ')}.
      A reply stating one branch's address, link, phone, hours or price to a customer who has
      not named a branch is replaced by the reviewed «${CLARIFY_BRANCH_KIND}» line — or the
      handoff line while that row does not exist or is unreviewed.\n`);
}

// D-033, stated rather than left to be noticed. A tenant whose prefix carries no marker is
// answered with the handoff line before the provider is reached; one whose marker appears
// for the first time starts answering from its own data, and that is a change of product.
if (!hasMarker) {
  process.stdout.write(`\nNOTE: no data marker. This tenant answers with the handoff line and never reaches
      the model (D-033). Correct for a tenant whose only rows are canned lines.\n`);
} else if (hadMarker === false) {
  process.stdout.write(`\nNOTE: the data marker appears for the FIRST time. This tenant stops taking the
      handoff line and starts answering from its own knowledge base. Read the order above.\n`);
}

if (before !== null && before.contentHash === rendered.contentHash) {
  process.stdout.write('\nThe compiled prefix is byte-identical to the live one. Nothing to publish.\n');
  process.exit(0);
}

// ---- every reply the founder marked wrong, against THIS prefix (D-120) --------
// Founder, 2026-09-24: *"No publish … that touches replies can go out unless every test
// passes, including all past failures."* The cases are answered by `handleReception` over
// the prefix just compiled, not the live one, so what is judged is what would go live. A
// case that reaches the model needs ANTHROPIC_API_KEY in this shell; without it that case
// FAILS rather than being skipped.
const modelKey = process.env['ANTHROPIC_API_KEY'] ?? '';
const gate = await gateTenant(db, {
  slug, now,
  callModel: modelKey === '' ? null : caseModelSeat((req) => callReception(req, modelKey)),
  compiled: {
    promptStable: rendered.promptStable, allowedNumbers: rendered.allowedNumbers,
    cannedHash: compiled.cannedHash, promptGate: rendered.promptGate,
  },
});
const verdict = renderGate([gate]);
process.stdout.write(`\n${verdict.text}\n`);
if (!gate.ok || !verdict.pass) {
  die(`reply cases fail against this configuration, so it ${doPublish ? 'was NOT published' : 'cannot be published'}.\n`
    + 'Fix the rows (or the case, if the expected answer itself is wrong), then run again.');
}

if (!doPublish) {
  process.stdout.write('\nDry run. Nothing was written. Re-run with --publish to apply.\n');
  process.exit(0);
}

// ---- the write -----------------------------------------------------------
// The draft is created here rather than beforehand so a refused compile cannot leave one
// behind: everything above this line is a read.
const { data: seqRow } = await db
  .from('config_revisions').select('seq').eq('tenant_id', tenantId).order('seq', { ascending: false }).limit(1).maybeSingle();
const nextSeq = Number((seqRow as Record<string, unknown> | null)?.['seq'] ?? 0) + 1;

const { data: draft, error: draftErr } = await db
  .from('config_revisions').insert({ tenant_id: tenantId, seq: nextSeq, status: 'draft', created_by: null })
  .select('id').maybeSingle();
if (draftErr) die(`could not create the draft revision: ${draftErr.message}`);
const revisionId = String((draft as Record<string, unknown>)['id']);

const out = await compileAndPublish(db, { tenantId, revisionId, channels, now });
if (!out.ok) die(`publish failed (${out.code}): ${out.detail}`);

process.stdout.write(`\nPUBLISHED  seq ${nextSeq}  revision ${out.revisionId}  content_hash ${out.contentHash}\n`);

// Read it back through the same loader the worker uses, because the evidence that a publish
// happened is the reply path being able to see it — not the insert returning without error.
const after = await loadLiveSnapshot(db, { tenantId, channel: channels[0] as string });
if (!after.ok) die(`published, but the live snapshot does not load back: ${after.code}`);
if (after.snapshot.contentHash !== rendered.contentHash) {
  die(`published, but the live snapshot reads ${after.snapshot.contentHash}, not ${rendered.contentHash}`);
}
if (after.snapshot.cannedHash !== compiled.cannedHash) {
  die(`published, but canned_hash reads ${String(after.snapshot.cannedHash)}, not ${compiled.cannedHash}`);
}
process.stdout.write('Read back through loadLiveSnapshot: the reply path sees it.\n');
