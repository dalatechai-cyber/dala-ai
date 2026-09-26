/**
 * The daily operations digest. QStash calls this once a day; nobody else does. The schedule
 * is ONE QStash schedule at `5 16 * * *` UTC — 00:05 Ulaanbaatar, so it reaches the founder
 * during his US day (founder, 2026-09-26, D-128 addendum). A second one (the earlier
 * `0 1 * * *`, 09:00 Ulaanbaatar) must not exist, or the report arrives twice.
 * Whenever it runs, it reports the Ulaanbaatar day that has just ended (`reportWindow`).
 * With `DAILY_REPORT_V2=true` it sends one merged report instead of three kinds of message.
 *
 * As with `workers/purge` and `workers/health`, **nothing in this file may branch** — a
 * condition here is a condition no test can reach. The decision is `@/lib/alerts/digest`.
 *
 * The schedule itself is NOT in this repository. `vercel.json` carries no `crons` block and
 * the cadence lives in the QStash console, exactly as the hourly purge does; a session
 * reading the repo cannot learn when this fires and must ask rather than infer.
 */
import { NextResponse } from 'next/server';
import { verifyQStashSignature } from '@/lib/queue/qstash';
import { supabaseWorker } from '@/lib/supabase/clients';
import { runDigestJob } from '@/lib/alerts/digest';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(request: Request): Promise<NextResponse> {
  const result = await runDigestJob(
    {
      db: supabaseWorker(),
      now: new Date(),
      verifySignature: (raw, signature) => verifyQStashSignature(raw, signature),
    },
    { rawBody: await request.text(), signature: request.headers.get('upstash-signature') },
  );
  return NextResponse.json(result.body, { status: result.status });
}
