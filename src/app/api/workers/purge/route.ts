/**
 * The scheduled retention purge. QStash calls this; nobody else does.
 *
 * As with `workers/health`, **nothing in this file may branch** — a condition here is a
 * condition no test can reach. The decision is `@/lib/worker/purge`.
 */
import { NextResponse } from 'next/server';
import { verifyQStashSignature } from '@/lib/queue/qstash';
import { supabaseWorker } from '@/lib/supabase/clients';
import { runPurgeJob } from '@/lib/worker/purge';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(request: Request): Promise<NextResponse> {
  const result = await runPurgeJob(
    {
      db: supabaseWorker(),
      now: new Date(),
      verifySignature: (raw, signature) => verifyQStashSignature(raw, signature),
    },
    { rawBody: await request.text(), signature: request.headers.get('upstash-signature') },
  );
  return NextResponse.json(result.body, { status: result.status });
}
