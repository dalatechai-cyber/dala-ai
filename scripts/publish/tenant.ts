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
 * ## Flipping a launch switch (D-154)
 *
 *     # what Вира going live would publish, judged in full — writes NOTHING
 *     … node scripts/publish/tenant.ts --slug dalatech --launch "Вира — маркетинг менежер=live"
 *
 *     # and then
 *     … node scripts/publish/tenant.ts --slug dalatech --launch "Вира — маркетинг менежер=live" --publish
 *
 * `--launch "<service name>=live|preregistration"`, repeatable. The compile, the reply cases
 * and the fact check all run against the switched states before anything is written. With
 * `--publish`, the new states are written to `services.launch_state` and the tenant is
 * published in the same run; if the publish then fails, the states are put back, so a switch
 * is never left flipped in the rows while the snapshot says otherwise. The website and every
 * channel read the snapshot, so they change at the publish's pointer move, together.
 * A service with no priced variant cannot be switched live: the command refuses before the
 * compile, so a staff member never goes live answering that its price is not announced.
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
import { loadLiveSnapshot, publishNeeded, type LoadOutcome } from '../../src/lib/prompt/publish.ts';
import { supabasePublish } from '../../src/lib/supabase/clients.ts';
import { SECTION_LABELS } from '../../src/lib/prompt/tenant.ts';
import { CLARIFY_BRANCH_KIND, branchNamesFromPrefix } from '../../src/lib/branches/branches.ts';
import { caseModelSeat, gateTenant, renderGate } from '../../src/lib/replycases/run.ts';
import { callReception, type CallOutcome } from '../../src/lib/model/reception.ts';
import { priceCall, type CacheMode } from '../../src/lib/spend/settle.ts';
import { factGate } from '../facts/gate.ts';
import { caseReferences, itemReferences, lookupOf, resolveDeterministicRows, LAUNCH_STATES, sameLaunch, type LaunchRecord, type LaunchState } from '../../src/lib/launch/launch.ts';

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

// `--launch "<service name>=<state>"`, as many as needed (D-154).
const launch = new Map<string, LaunchState>();
process.argv.forEach((a, i) => {
  if (a !== '--launch') return;
  const v = process.argv[i + 1] ?? '';
  const at = v.lastIndexOf('=');
  const name = at < 0 ? '' : v.slice(0, at).normalize('NFC').trim();
  const state = at < 0 ? '' : v.slice(at + 1).trim();
  if (name === '' || !(LAUNCH_STATES as readonly string[]).includes(state)) {
    die(`--launch takes "<service name>=${LAUNCH_STATES.join('|')}", got ${JSON.stringify(v)}`);
  }
  if (launch.has(name) && launch.get(name) !== state) die(`--launch names «${name}» twice with different states`);
  launch.set(name, state as LaunchState);
});

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

// ---- what is live now, on EVERY channel -----------------------------------
// One snapshot per channel, and each is read: a channel added since the last publish has
// none, and judging by the first channel alone printed «Nothing to publish» for it (D-142).
// An unreadable read is not an answer, so it stops the run rather than counting as either.
const liveByChannel = new Map<string, LoadOutcome>();
for (const channel of channels) {
  const got = await loadLiveSnapshot(db, { tenantId, channel });
  if (!got.ok && got.code === 'unavailable') die(`live snapshot for ${channel} unreadable: ${got.detail}`);
  liveByChannel.set(channel, got);
}
// The diff below is printed against one live snapshot; every channel's is the same compile.
const firstLive = channels.map((c) => liveByChannel.get(c)).find((o) => o?.ok === true);
const before = firstLive !== undefined && firstLive.ok ? firstLive.snapshot : null;

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

// ---- every launch condition names one of this tenant's services (D-154) ----------
// The row-level conditions are foreign keys; the pieces of a templated reply are jsonb, so
// they are checked here. A piece naming a service this tenant does not have is a switch that
// can never be flipped, and it would silently never show.
{
  const [svcRes, detRes, caseRes] = await Promise.all([
    db.from('services').select('id').eq('tenant_id', tenantId),
    db.from('deterministic_replies').select('intent, items').eq('tenant_id', tenantId),
    db.from('reply_cases').select('id, when_launch').eq('tenant_id', tenantId).eq('active', true),
  ]);
  if (svcRes.error) die(`services unreadable: ${svcRes.error.message}`);
  if (detRes.error) die(`deterministic_replies unreadable: ${detRes.error.message}`);
  if (caseRes.error) die(`reply_cases unreadable: ${caseRes.error.message}`);
  const ids = new Set((svcRes.data ?? []).map((r) => String((r as Record<string, unknown>)['id']).toLowerCase()));
  const dangling = [
    ...itemReferences(detRes.data).filter((r) => !ids.has(r.serviceId)).map((d) => `fixed reply ${d.intent}: ${d.serviceId}`),
    ...caseReferences(caseRes.data).filter((r) => r.serviceId === null || !ids.has(r.serviceId))
      .map((c) => `reply case ${c.id}: ${c.serviceId ?? 'when_launch does not parse'}`),
  ];
  if (dangling.length > 0) {
    die(`launch conditions name services this tenant does not have:\n  ${dangling.join('\n  ')}`);
  }
}

// ---- a service goes live only with a price (founder, 2026-09-27) -------------------
// Live mode answers «how much?» from the price rows. A service with no priced variant would
// go live saying its price is not announced, so the switch refuses until a price exists.
{
  const toLive = [...launch].filter(([, state]) => state === 'live').map(([name]) => name);
  if (toLive.length > 0) {
    const [svcRes, varRes] = await Promise.all([
      db.from('services').select('id, name').eq('tenant_id', tenantId),
      db.from('service_variants').select('service_id, price_min').eq('tenant_id', tenantId),
    ]);
    if (svcRes.error) die(`services unreadable: ${svcRes.error.message}`);
    if (varRes.error) die(`service_variants unreadable: ${varRes.error.message}`);
    const priced = new Set((varRes.data ?? [])
      .filter((v) => (v as Record<string, unknown>)['price_min'] !== null)
      .map((v) => String((v as Record<string, unknown>)['service_id'])));
    const unpriced = toLive.filter((name) => (svcRes.data ?? []).some((s) => {
      const r = s as Record<string, unknown>;
      return String(r['name']).normalize('NFC') === name && !priced.has(String(r['id']));
    }));
    if (unpriced.length > 0) {
      die(`cannot go live without a price: ${unpriced.map((n) => `«${n}»`).join(', ')}. Add its price rows first.`);
    }
  }
}

const compiled = await compileStablePrefix(db, {
  tenantId, approvedAt: now.toISOString(), ...(launch.size === 0 ? {} : { launch }),
});
if (!compiled.ok) {
  die(compiled.code === 'refused'
    ? `compile REFUSED (${compiled.refusal.code}): ${compiled.refusal.sections.join(', ')}`
    : `compile failed (${compiled.code}): ${compiled.detail}`);
}
const { rendered } = compiled;

// D-154: a fixed reply whose condition or pieces do not parse would never answer, in any
// state, with nothing said. Refused here, where an operator reads it, instead.
{
  const { data: detRows, error: detErr } = await db.from('deterministic_replies')
    .select('intent, body, web_body, matcher, when_service_id, when_launch_state, items').eq('tenant_id', tenantId).eq('enabled', true);
  if (detErr) die(`deterministic_replies unreadable: ${detErr.message}`);
  const broken = resolveDeterministicRows(detRows, lookupOf(compiled.launch)).withheld
    .filter((w) => w.reason === 'bad_condition' || w.reason === 'bad_items');
  if (broken.length > 0) {
    die(`fixed replies that can never answer (their launch condition or pieces do not parse):\n  ${broken.map((w) => `${w.intent}: ${w.reason}`).join('\n  ')}`);
  }
}

// The switches, before and after. Printed on every run: which services this publish says are
// live is the one line the website and every channel will change on.
const liveLaunch: LaunchRecord[] | null = before?.launchStates ?? null;
const launchLine = (r: LaunchRecord): string => {
  const was = liveLaunch?.find((x) => x.serviceId === r.serviceId)?.state ?? null;
  return `  ${r.state === 'live' ? 'LIVE      ' : 'PRE-REG   '} ${r.name}${was !== null && was !== r.state ? `  (was ${was})` : was === null ? '  (not recorded before)' : ''}`;
};
process.stdout.write(`launch          ${sameLaunch(liveLaunch, compiled.launch) ? 'unchanged' : 'CHANGES'}\n${compiled.launch.map(launchLine).join('\n')}\n`);

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

const need = publishNeeded(channels, liveByChannel, {
  contentHash: rendered.contentHash, cannedHash: compiled.cannedHash, launchStates: compiled.launch,
});
if (!need.needed) {
  process.stdout.write(`\nThe compiled prefix is byte-identical to the live one on every channel (${channels.join(', ')}). Nothing to publish.\n`);
  process.exit(0);
}
if (need.missing.length > 0) {
  process.stdout.write(`\nNO SNAPSHOT on ${need.missing.join(', ')}: every reply there is refused (no_snapshot) until this is published.\n`);
}
if (need.changed.length > 0) process.stdout.write(`\nchanged on ${need.changed.join(', ')}\n`);

// ---- every reply the founder marked wrong, against THIS prefix (D-120) --------
// Founder, 2026-09-24: *"No publish … that touches replies can go out unless every test
// passes, including all past failures."* The cases are answered by `handleReception` over
// the prefix just compiled, not the live one, so what is judged is what would go live. A
// case that reaches the model is listed as not run and does not block (D-137: no spend by
// default), unless it is an exact case, whose row stopped answering, and that fails.
// `--with-model` answers the model cases too, spending, by hand before a big change; it
// needs ANTHROPIC_API_KEY in this shell, and without it a model case FAILS.
const withModel = process.argv.includes('--with-model');
const calls: Array<{ out: CallOutcome; model: string }> = [];
const modelKey = withModel ? (process.env['ANTHROPIC_API_KEY'] ?? '') : '';
const gate = await gateTenant(db, {
  slug, now,
  modelCases: withModel ? 'fail' : 'skip',
  callModel: modelKey === '' ? null : caseModelSeat(async (req) => {
    const out = await callReception(req, modelKey);
    calls.push({ out, model: req.modelId });
    return out;
  }),
  compiled: {
    promptStable: rendered.promptStable, allowedNumbers: rendered.allowedNumbers,
    cannedHash: compiled.cannedHash, promptGate: rendered.promptGate,
    launchStates: compiled.launch,
  },
});
const verdict = renderGate([gate]);
process.stdout.write(`\n${verdict.text}\n`);

// What the model run cost (D-151: the report says it). Priced from `model_prices` at the
// tenant's cache mode, as the worker settles a live reply; a call that cannot be priced is
// named, never counted as free.
if (withModel) {
  const { data: t, error: tErr } = await db.from('tenants').select('prompt_cache_mode').eq('id', tenantId).maybeSingle();
  const raw = (t as Record<string, unknown> | null)?.['prompt_cache_mode'];
  const mode = (raw === 'off' || raw === '5m' || raw === '1h') ? raw as CacheMode : null;
  let nano = 0n;
  const unpriced: string[] = [];
  for (const { out: c, model: asked } of calls) {
    // A timed-out or dropped call may still have been billed; it is named, never free.
    if (c.kind === 'retryable') { unpriced.push(`retryable ${c.reason}: possibly billed, not priced`); continue; }
    if (c.usage === undefined) continue;
    if (mode === null) { unpriced.push(`cache mode unreadable${tErr ? ` (${tErr.message})` : ''}`); continue; }
    const model = c.kind === 'ok' && c.modelReturned !== '' ? c.modelReturned : asked;
    const p = await priceCall(db, model, c.usage, mode, now);
    if (p.ok) nano += p.priced.cost;
    else unpriced.push(p.detail);
  }
  const usd = Number(nano) / 1e9;
  process.stdout.write(`\nMODEL RUN COST  ${calls.length} call(s), $${usd.toFixed(4)}`
    + `${unpriced.length > 0 ? `, plus ${unpriced.length} call(s) that could not be priced (${[...new Set(unpriced)].join('; ')})` : ''}\n`);
}
if (!gate.ok || !verdict.pass) {
  die(`reply cases fail against this configuration, so it ${doPublish ? 'was NOT published' : 'cannot be published'}.\n`
    + 'Fix the rows (or the case, if the expected answer itself is wrong), then run again.');
}

// ---- every copy of every fact agrees (founder, 2026-09-27) ---------------------
// Price rows, FAQ, fixed replies, canned lines, KB documents, the platform's approved lines,
// and the copies outside this project (config/external-fact-copies.json, read from the
// sibling checkout). A copy that disagrees, or one that cannot be read, stops the publish.
const facts = await factGate(db, { slug, tenantId, external: 'require' });
process.stdout.write(`\n${facts.text}\n`);
if (facts.wrong.length > 0 || facts.unchecked.length > 0) {
  die(`copies of this tenant's facts disagree or could not be read, so it ${doPublish ? 'was NOT published' : 'cannot be published'}.\n`
    + 'Make every copy say what the rows say (or fix the row), check out the sibling repo if one is missing, then run again.');
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

// D-154: the switches go into the rows first, so the compile that publishes reads them and
// the next plain publish keeps them. If anything after this fails, they are put back.
// Matched by NFC name, the form `--launch` and the compile's override both use.
const flips = compiled.launch.filter((r) => launch.has(r.name.normalize('NFC')));
const priorState = new Map<string, LaunchState>();
if (flips.length > 0) {
  const { data: cur, error: curErr } = await db.from('services').select('id, launch_state').eq('tenant_id', tenantId);
  if (curErr) die(`services unreadable: ${curErr.message}`);
  for (const r of (cur ?? []) as Record<string, unknown>[]) priorState.set(String(r['id']), r['launch_state'] as LaunchState);
  // The way back, printed BEFORE anything is written: if this process dies between the flip
  // and the publish, the operator has the exact SQL, and the next publish must not run first.
  process.stdout.write(`\nFlipping ${flips.map((f) => `«${f.name}» → ${f.state}`).join(', ')}. If this run dies before «PUBLISHED»,\n`
    + `restore the rows before anything else is published:\n`
    + flips.map((f) => `  update services set launch_state = '${priorState.get(f.serviceId) ?? 'preregistration'}' where id = '${f.serviceId}';`).join('\n') + '\n');
}

/** The live revision now, or null when it cannot be read. */
async function liveRevision(): Promise<string | null> {
  const { data, error } = await db.from('tenants').select('live_revision_id').eq('id', tenantId).maybeSingle();
  if (error || data === null) return null;
  const v = (data as Record<string, unknown>)['live_revision_id'];
  return typeof v === 'string' ? v : null;
}

/**
 * Put the switches back — but only when the new revision is NOT live. A publish can report a
 * failure after its pointer move committed (a lost response); reverting the rows then would
 * leave rows saying one thing under a live snapshot saying another. When that cannot be
 * told, nothing is reverted and the operator is told exactly what to check.
 */
async function putBack(reason: string): Promise<void> {
  if (flips.length === 0) return;
  const live = await liveRevision();
  if (live === revisionId) {
    process.stderr.write(`publish: ${reason}, but revision ${revisionId} IS live. The switches stay as published.\n`);
    return;
  }
  if (live === null) {
    process.stderr.write(`publish: ${reason}, and which revision is live could not be read. The switches were NOT put back.\n`
      + `  Check tenants.live_revision_id; if it is not ${revisionId}, run the restore SQL printed above.\n`);
    return;
  }
  for (const f of flips) {
    const was = priorState.get(f.serviceId);
    if (was === undefined || was === f.state) continue;
    const { error } = await db.from('services').update({ launch_state: was }).eq('tenant_id', tenantId).eq('id', f.serviceId);
    if (error) {
      process.stderr.write(`publish: COULD NOT PUT BACK «${f.name}» to ${was}: ${error.message}\n`
        + `  run: update services set launch_state = '${was}' where id = '${f.serviceId}';\n`);
    }
  }
}

let out: Awaited<ReturnType<typeof compileAndPublish>>;
try {
  for (const f of flips) {
    const { error } = await db.from('services').update({ launch_state: f.state }).eq('tenant_id', tenantId).eq('id', f.serviceId);
    if (error) throw new Error(`could not set «${f.name}» to ${f.state}: ${error.message}`);
  }
  out = await compileAndPublish(db, { tenantId, revisionId, channels, now });
} catch (err) {
  // A throw anywhere between the first flip and the publish's answer: never leave rows flipped.
  const why = err instanceof Error ? err.message : String(err);
  await putBack(why);
  die(`${why}. Nothing was published by this run.`);
}
if (!out.ok) {
  await putBack(`publish failed (${out.code})`);
  die(`publish failed (${out.code}): ${out.detail}`);
}
// The rows were read again by that compile; if anything else changed them in between, what
// went live is not what was judged above.
if (!sameLaunch(out.launch, compiled.launch)) {
  die(`published, but the launch states it read differ from the ones judged above. Re-run the dry run and read it.`);
}

process.stdout.write(`\nPUBLISHED  seq ${nextSeq}  revision ${out.revisionId}  content_hash ${out.contentHash}\n`);

// Read it back through the same loader the worker uses, because the evidence that a publish
// happened is the reply path being able to see it — not the insert returning without error.
// Every channel, for the reason the skip check reads every channel (D-142).
for (const channel of channels) {
  const after = await loadLiveSnapshot(db, { tenantId, channel });
  if (!after.ok) die(`published, but the live snapshot for ${channel} does not load back: ${after.code}`);
  if (after.snapshot.contentHash !== rendered.contentHash) {
    die(`published, but ${channel}'s live snapshot reads ${after.snapshot.contentHash}, not ${rendered.contentHash}`);
  }
  if (after.snapshot.cannedHash !== compiled.cannedHash) {
    die(`published, but ${channel}'s canned_hash reads ${String(after.snapshot.cannedHash)}, not ${compiled.cannedHash}`);
  }
  if (!sameLaunch(after.snapshot.launchStates, compiled.launch)) {
    die(`published, but ${channel}'s launch states do not read back as compiled`);
  }
}
process.stdout.write(`Read back through loadLiveSnapshot on ${channels.join(', ')}: the reply path sees it.\n`);
