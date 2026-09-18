/**
 * Publish and rollback (V1.md 3.1).
 *
 * ## The pointer is `tenants.live_revision_id`, and that is the whole design
 *
 * Snapshots are **immutable**: `config_snapshots` has no update path, and publishing
 * inserts rather than edits. So the live configuration is not a mutable record that gets
 * rewritten — it is a pointer at one of several complete, frozen renderings.
 *
 * Two consequences fall straight out, and both are why it is shaped this way:
 *
 *  - **Rollback re-renders nothing.** The previous snapshot is still sitting there,
 *    byte-for-byte, with the same `content_hash` — so rolling back also restores the
 *    prompt-cache entry that was already warm, rather than paying to rebuild one. A
 *    rollback that had to recompile could produce a *different* prefix from the same
 *    rows if any input drifted, which is the one thing a rollback must never do.
 *  - **The database refuses a cross-tenant pointer.** The FK is composite —
 *    `(tenants.id, live_revision_id) → config_revisions (tenant_id, id)` — so tenant A
 *    cannot be pointed at tenant B's revision even by a bug holding `service_role`,
 *    which carries BYPASSRLS and would sail through any policy.
 *
 * ## Insert first, point second. Never the other way round.
 *
 * If the pointer moved first there would be a window in which `live_revision_id` names a
 * revision with no snapshot for the channel. Reception would find nothing to render and
 * 503 — for every customer of that tenant, for as long as the window lasted. The reverse
 * order has no such window: an inserted snapshot nobody points at is invisible and
 * harmless.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Rendered } from './render.ts';

export type PublishOutcome =
  | { ok: true; revisionId: string }
  | { ok: false; code: 'publish_failed' | 'no_snapshot' | 'not_draft'; detail: string };

export type SnapshotInput = {
  channel: string;
  rendered: Rendered;
  /** D-058. The identity of the canned lines this prefix carries; null predates the column. */
  cannedHash?: string | null;
  compiledBy?: string | null;
};

/**
 * Publish a draft revision: insert its snapshots, mark it published, move the pointer,
 * and supersede whatever was live before.
 *
 * Every step refuses on error rather than continuing. A partially published config is
 * worse than an unpublished one, because it looks live.
 */
export async function publishRevision(
  db: SupabaseClient,
  input: { tenantId: string; revisionId: string; snapshots: readonly SnapshotInput[]; now: Date; publishedBy?: string | null },
): Promise<PublishOutcome> {
  if (input.snapshots.length === 0) {
    return { ok: false, code: 'no_snapshot', detail: 'a revision with no snapshot cannot render a reply' };
  }

  // The revision must still be a draft. Publishing an already-published revision would
  // re-insert snapshots against an immutable primary key and half-fail.
  const { data: rev, error: revErr } = await db
    .from('config_revisions')
    .select('status')
    .eq('tenant_id', input.tenantId)
    .eq('id', input.revisionId)
    .maybeSingle();
  if (revErr) return { ok: false, code: 'publish_failed', detail: `config_revisions unreadable: ${revErr.message}` };
  if (rev === null) return { ok: false, code: 'not_draft', detail: 'no such revision for this tenant' };
  if ((rev as Record<string, unknown>)['status'] !== 'draft') {
    return { ok: false, code: 'not_draft', detail: `revision is ${String((rev as Record<string, unknown>)['status'])}, not draft` };
  }

  // 1. THE INSERT. Immutable rows, one per channel.
  const { error: snapErr } = await db.from('config_snapshots').insert(
    input.snapshots.map((s) => ({
      tenant_id: input.tenantId,
      revision_id: input.revisionId,
      channel: s.channel,
      content_hash: s.rendered.contentHash,
      prompt_stable: s.rendered.promptStable,
      prompt_gate: s.rendered.promptGate,
      prompt_volatile: '',              // L4 is per-request and is never snapshotted.
      prompt_chars: s.rendered.promptChars,
      allowed_numbers: s.rendered.allowedNumbers,
      canned_hash: s.cannedHash ?? null,
      compiled_at: input.now.toISOString(),
      compiled_by: s.compiledBy ?? null,
    })),
  );
  if (snapErr) return { ok: false, code: 'publish_failed', detail: `snapshot insert failed: ${snapErr.message}` };

  // 2. Mark it published. `published_has_a_time` makes the timestamp non-optional.
  const { error: markErr } = await db
    .from('config_revisions')
    .update({ status: 'published', published_at: input.now.toISOString() })
    .eq('tenant_id', input.tenantId)
    .eq('id', input.revisionId)
    .eq('status', 'draft');           // CAS: only a draft may become published.
  if (markErr) return { ok: false, code: 'publish_failed', detail: `revision update failed: ${markErr.message}` };

  // 3. Supersede the outgoing one, BEFORE moving the pointer — two rows claiming
  //    'published' is a state nothing else in the schema can disambiguate.
  const { error: supErr } = await db
    .from('config_revisions')
    .update({ status: 'superseded' })
    .eq('tenant_id', input.tenantId)
    .eq('status', 'published')
    .neq('id', input.revisionId);
  if (supErr) return { ok: false, code: 'publish_failed', detail: `supersede failed: ${supErr.message}` };

  // 4. THE POINTER MOVE. One UPDATE, and it is the moment the change goes live.
  const { error: ptrErr } = await db
    .from('tenants')
    .update({ live_revision_id: input.revisionId })
    .eq('id', input.tenantId);
  if (ptrErr) return { ok: false, code: 'publish_failed', detail: `pointer move failed: ${ptrErr.message}` };

  return { ok: true, revisionId: input.revisionId };
}

/**
 * Roll back to an earlier revision. One UPDATE — but only after checking the target can
 * actually render.
 *
 * The check is not ceremony. Rolling back to a revision with no snapshot for the channel
 * would 503 every conversation for that tenant, and a rollback is by definition something
 * done in a hurry, when something is already wrong. It must not be able to make it worse.
 */
export async function rollbackTo(
  db: SupabaseClient,
  input: { tenantId: string; revisionId: string; channels: readonly string[] },
): Promise<PublishOutcome> {
  for (const channel of input.channels) {
    const { data, error } = await db
      .from('config_snapshots')
      .select('content_hash')
      .eq('tenant_id', input.tenantId)
      .eq('revision_id', input.revisionId)
      .eq('channel', channel)
      .maybeSingle();
    if (error) return { ok: false, code: 'publish_failed', detail: `config_snapshots unreadable: ${error.message}` };
    if (data === null) {
      return { ok: false, code: 'no_snapshot', detail: `revision has no snapshot for channel ${channel}: rolling back to it would 503 every conversation` };
    }
  }

  const { error } = await db
    .from('tenants')
    .update({ live_revision_id: input.revisionId })
    .eq('id', input.tenantId);
  if (error) return { ok: false, code: 'publish_failed', detail: `pointer move failed: ${error.message}` };

  return { ok: true, revisionId: input.revisionId };
}

export type LiveSnapshot = {
  revisionId: string;
  channel: string;
  contentHash: string;
  promptStable: string;
  allowedNumbers: string[];
  /** D-058. null means the snapshot predates the canned section moving into the prefix. */
  cannedHash: string | null;
  /**
   * D-084. The PLATFORM sections only — the corpus `disclosesPrompt` matches against.
   * null means the snapshot predates `0029`; the caller falls back to `promptStable`.
   */
  promptGate: string | null;
};

export type LoadOutcome =
  | { ok: true; snapshot: LiveSnapshot }
  /** No published config. The tenant is not ready; the route refuses. */
  | { ok: false; code: 'no_live_revision' | 'no_snapshot' | 'unavailable'; detail: string };

/**
 * The live snapshot for a channel, via the pointer.
 *
 * Every failure is a refusal. A tenant with no live revision is not "use the defaults" —
 * there are no defaults, and inventing one would be a bot answering with a prompt nobody
 * approved. `tenants.active_requires_published_config` already makes this state
 * unreachable for an active tenant; this is the runtime half of the same rule.
 */
export async function loadLiveSnapshot(
  db: SupabaseClient,
  input: { tenantId: string; channel: string },
): Promise<LoadOutcome> {
  const { data: tenant, error: tErr } = await db
    .from('tenants')
    .select('live_revision_id')
    .eq('id', input.tenantId)
    .maybeSingle();
  if (tErr) return { ok: false, code: 'unavailable', detail: `tenants unreadable: ${tErr.message}` };
  if (tenant === null) return { ok: false, code: 'unavailable', detail: 'no such tenant' };

  const revisionId = (tenant as Record<string, unknown>)['live_revision_id'];
  if (typeof revisionId !== 'string' || revisionId === '') {
    return { ok: false, code: 'no_live_revision', detail: 'tenant has no published configuration' };
  }

  const { data, error } = await db
    .from('config_snapshots')
    .select('content_hash, prompt_stable, prompt_gate, allowed_numbers, canned_hash')
    .eq('tenant_id', input.tenantId)
    .eq('revision_id', revisionId)
    .eq('channel', input.channel)
    .maybeSingle();
  if (error) return { ok: false, code: 'unavailable', detail: `config_snapshots unreadable: ${error.message}` };
  if (data === null) return { ok: false, code: 'no_snapshot', detail: `no snapshot for channel ${input.channel}` };

  const row = data as Record<string, unknown>;
  const allowed = row['allowed_numbers'];
  return {
    ok: true,
    snapshot: {
      revisionId,
      channel: input.channel,
      contentHash: String(row['content_hash']),
      promptStable: String(row['prompt_stable']),
      allowedNumbers: Array.isArray(allowed) ? allowed.map(String) : [],
      // NULL is not "unknown", it is a FORMAT marker: this snapshot was published before
      // the canned lines moved into the prefix (D-058), so its prefix does not contain
      // them and the caller must still append them to the volatile tail. Treating it as a
      // skipped check would be wrong in the other direction — the section would go missing
      // entirely and the model would be told to reproduce sentences it cannot see.
      cannedHash: typeof row['canned_hash'] === 'string' ? row['canned_hash'] : null,
      // Null is a FORMAT marker too (D-084, `0029`): this snapshot predates the column, so
      // its gate text was never stored separately. The caller falls back to the whole
      // prefix — today's behaviour, which over-refuses rather than under-refuses — and the
      // next republish fills it in. Treating null as "no corpus" would silently disable
      // the disclosure check, which is the one direction that must never be the default.
      promptGate: typeof row['prompt_gate'] === 'string' ? row['prompt_gate'] : null,
    },
  };
}
