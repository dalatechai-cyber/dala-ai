/**
 * WHICH 60-character run refused this reply?
 *
 *     NEXT_PUBLIC_SUPABASE_URL=… SUPABASE_SECRET_PUBLISH=… \
 *       node scripts/diagnose/disclosure-window.ts <tenant-slug> [reply-file]
 *
 * The reply comes from a file, or from stdin when no file is given — never from an
 * argument, because a shell mangles the newlines and the fold depends on them.
 *
 * ## Why this exists
 *
 * On 2026-09-18 at 04:02 a customer asked Matrix how many branches it has. The model
 * answered «Матрикс эко салон нийт зургаан салбартай» — correct, and a 41-character exact
 * match from the tenant's own knowledge base, which is what the knowledge base is FOR. The
 * reply also quoted `refusal_price_unlisted` byte-exact. `outbound_disclosure` refused the
 * whole thing and the customer got the generic handoff.
 *
 * `quality_flags` said `a 60-character run of the system prompt appeared in the reply` and
 * did not say which run. Finding it from the outside took a long sequence of substring
 * probes against the live snapshot, three of which were wrong — the hours line that turned
 * out not to be in the prefix at all, and a knowledge-base sentence that turned out to be
 * 58 characters, under the threshold. The guard knew the answer at the instant it refused.
 *
 * So this does not re-implement the matching. It calls `disclosureWindows`, of which
 * `disclosesPrompt` is now the boolean reduction. A diagnostic that re-implements its
 * subject is the mistake D-077 committed inside the tool built to investigate D-077.
 *
 * It is READ-ONLY and takes the tenant as an ARGUMENT — no tenant is named in this file.
 */
import { readFileSync } from 'node:fs';
import { supabasePublish } from '../../src/lib/supabase/clients.ts';
import { disclosureWindows } from '../../src/lib/guard/outbound.ts';

function die(why: string): never {
  console.error(`disclosure-window: ${why}`);
  process.exit(1);
}

const slug = process.argv[2];
if (slug === undefined || slug === '') die('usage: disclosure-window.ts <tenant-slug> [reply-file]');

const replyPath = process.argv[3];
const reply = replyPath === undefined
  ? readFileSync(0, 'utf8')
  : readFileSync(replyPath, 'utf8');
if (reply.trim() === '') die('the reply is empty — pass a file, or pipe it on stdin');

const db = supabasePublish();

const { data: tenantRow, error: tenantErr } = await db
  .from('tenants').select('id, default_locale, live_revision_id').eq('slug', slug).maybeSingle();
if (tenantErr) die(`tenants unreadable: ${tenantErr.message}`);
if (tenantRow === null) die(`no tenant with slug ${slug}`);
const t = tenantRow as Record<string, unknown>;
const revisionId = t['live_revision_id'];
if (revisionId === null || revisionId === undefined) die(`${slug} has no live revision — nothing is published`);

const { data: snapRow, error: snapErr } = await db
  .from('config_snapshots').select('prompt_stable, content_hash').eq('revision_id', revisionId).maybeSingle();
if (snapErr) die(`config_snapshots unreadable: ${snapErr.message}`);
if (snapRow === null) die('the live revision has no snapshot row');
const snap = snapRow as Record<string, unknown>;
const prefix = String(snap['prompt_stable'] ?? '');

// EVERY canned row, not only the reviewed ones. The guard builds its exemption from what
// the request path passes it, and narrowing here would report offenders the guard exempts.
const { data: cannedRows, error: cannedErr } = await db
  .from('canned_responses').select('kind, body')
  .eq('tenant_id', t['id']).eq('locale', t['default_locale']);
if (cannedErr) die(`canned_responses unreadable: ${cannedErr.message}`);
const canned = (cannedRows ?? []).map((r) => String((r as Record<string, unknown>)['body'] ?? ''));

const windows = disclosureWindows(reply, prefix, canned);

console.log(`tenant           ${slug}`);
console.log(`live content_hash ${String(snap['content_hash'] ?? '').slice(0, 8)}  (${prefix.length} chars)`);
console.log(`canned rows      ${canned.length}`);
console.log(`reply            ${[...reply].length} chars`);
console.log('');

if (windows.length === 0) {
  // Not "the guard is wrong": the guard runs on the snapshot that was live AT THE TIME,
  // and a republish since then changes the corpus. Say that rather than imply a bug.
  console.log('NO offending window against the CURRENT live snapshot.');
  console.log('If this reply was refused earlier, the prefix has been republished since —');
  console.log('the corpus it was refused against is a different one.');
  process.exit(0);
}

console.log(`${windows.length} offending window(s) — folded, which is what was compared:`);
for (const w of windows) console.log(`\n  ${JSON.stringify(w)}`);
console.log('\nEach is a run present in the compiled prefix and in no approved line.');
