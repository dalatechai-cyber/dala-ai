/**
 * The scheduled health check. QStash calls this; nobody else does.
 *
 * As with `workers/reception`, **nothing in this file may branch** — a condition here is a
 * condition no test can reach. The decision is `@/lib/worker/health`.
 */
import { NextResponse } from 'next/server';
import { enqueueReception, verifyQStashSignature } from '@/lib/queue/qstash';
import { supabaseWorker } from '@/lib/supabase/clients';
import { runHealthJob } from '@/lib/worker/health';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(request: Request): Promise<NextResponse> {
  const result = await runHealthJob(
    {
      db: supabaseWorker(),
      now: new Date(),
      verifySignature: (raw, signature) => verifyQStashSignature(raw, signature),
      enqueue: (job) => enqueueReception(job),
    },
    { rawBody: await request.text(), signature: request.headers.get('upstash-signature') },
  );
  return NextResponse.json(result.body, { status: result.status });
}
