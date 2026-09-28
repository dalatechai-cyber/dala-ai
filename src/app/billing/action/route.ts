/**
 * The founder's pause / resume tap from Telegram (D-156). GET shows a confirmation page and
 * changes nothing (a link preview is a GET); only the form's POST acts. The link is signed
 * and expires (`@/lib/billing/links`).
 */
import { NextResponse } from 'next/server';
import { supabaseBilling } from '@/lib/supabase/clients';
import { runActionJob } from '@/lib/billing/jobs';
import { sendFounderTelegram } from '@/lib/billing/send';
import { actionKindOf } from '@/lib/billing/links';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const HTML = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex' } as const;

async function handle(request: Request, method: 'GET' | 'POST'): Promise<NextResponse> {
  const token = method === 'GET'
    ? new URL(request.url).searchParams.get('t') ?? ''
    : String((await request.formData().catch(() => new FormData())).get('t') ?? '');
  const page = await runActionJob({
    db: supabaseBilling, now: new Date(), method, token, kind: actionKindOf(token),
    notify: (text) => sendFounderTelegram({ text }),
  });
  return new NextResponse(page.html, { status: page.status, headers: HTML }) as NextResponse;
}

export const GET = (request: Request) => handle(request, 'GET');
export const POST = (request: Request) => handle(request, 'POST');
