/**
 * The Instagram comment poll (D-146). A QStash schedule calls this; nobody else does.
 *
 * As with `workers/health`, nothing in this file may branch — the decision is
 * `@/lib/comments/poll`, where a test can reach it.
 */
import { NextResponse } from 'next/server';
import { enqueueReception, verifyQStashSignature } from '@/lib/queue/qstash';
import { supabaseWorker } from '@/lib/supabase/clients';
import { loadTenantSecret } from '@/lib/secrets/tenantSecret';
import { handleMetaEntry } from '@/lib/webhook/entry';
import { graphGetJson, runInstagramCommentPoll } from '@/lib/comments/poll';
import { required } from '@/lib/env';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(request: Request): Promise<NextResponse> {
  const db = supabaseWorker();
  const log = (level: 'info' | 'warn' | 'error', event: string, fields?: Record<string, unknown>) =>
    console[level](`[ig-comments] ${event}`, fields ?? {});
  const result = await runInstagramCommentPoll(
    {
      db,
      now: new Date(),
      verifySignature: (raw, signature) => verifyQStashSignature(raw, signature),
      graphVersionDefault: () => required('META_GRAPH_VERSION'),
      loadToken: async ({ tenantId, channelId }) => {
        const secret = await loadTenantSecret(db, { tenantId, channelId, kind: 'page_token' });
        return secret.ok ? { ok: true, token: secret.secret } : { ok: false, detail: secret.code };
      },
      graphGet: (input) => graphGetJson(input),
      handleEntry: (input) => handleMetaEntry({ db, enqueue: enqueueReception, log }, input),
      log,
    },
    { rawBody: await request.text(), signature: request.headers.get('upstash-signature') },
  );
  return NextResponse.json(result.body, { status: result.status });
}
