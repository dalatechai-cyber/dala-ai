/**
 * Shared by the billing operator commands. Run from the founder's shell, with
 * `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SECRET_PUBLISH` (the operator key; never set in
 * cloud sessions or in Vercel), after `npm install`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabasePublish } from '../../src/lib/supabase/clients.ts';
import { BILLING_BLOCK_KEYS, loadSignedWording, type Wording } from '../../src/lib/billing/templates.ts';

export const out = (s = ''): void => { process.stdout.write(`${s}\n`); };

export function die(cmd: string, message: string, code = 2): never {
  process.stderr.write(`${cmd}: ${message}\n`);
  process.exit(code);
}

/** `--name value`. Repeated flags: `args('staff')`. A flag with no value dies. */
export function flag(cmd: string, name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) die(cmd, `--${name} needs a value`);
  return v;
}

export function flags(cmd: string, name: string): string[] {
  const vals: string[] = [];
  process.argv.forEach((a, i) => {
    if (a !== `--${name}`) return;
    const v = process.argv[i + 1];
    if (v === undefined || v.startsWith('--')) die(cmd, `--${name} needs a value`);
    vals.push(v);
  });
  return vals;
}

export const has = (name: string): boolean => process.argv.includes(`--${name}`);

export function refuseCredentialArgs(cmd: string): void {
  if (process.argv.some((a) => /^--(key|secret|token|password)/u.test(a))) {
    die(cmd, 'credentials are read from the environment, never from an argument');
  }
}

export function operatorDb(): SupabaseClient {
  return supabasePublish();
}

/**
 * The unsigned drafts, for a TEST account only. The engine applies them only to accounts
 * with `is_test`; a live client never receives a draft.
 */
export function draftWording(dir = 'prompt/drafts/billing'): Wording {
  const blocks = new Map<string, string>();
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((x) => x.startsWith('billing_') && x.endsWith('.mn.txt'))) {
      const key = f.slice(0, -'.mn.txt'.length);
      if ((BILLING_BLOCK_KEYS as string[]).includes(key)) blocks.set(key, readFileSync(`${dir}/${f}`, 'utf8').trim().normalize('NFC'));
    }
  }
  return { source: 'draft', blocks };
}

/**
 * The wording of computed invoice lines. A LIVE client's lines use signed blocks only (no
 * unsigned Mongolian reaches a client, even through a confirmed schedule); a TEST account may
 * use the drafts, so the test can run before signing.
 */
export async function labelWording(db: SupabaseClient, isTest: boolean): Promise<{ wording: Wording; note: string }> {
  const signed = await loadSignedWording(db);
  if (!signed.ok) throw new Error(signed.detail);
  if (!isTest) {
    const missing = ['billing_line_months', 'billing_line_team_discount', 'billing_line_annual_free'].filter((k) => !signed.wording.blocks.has(k));
    if (missing.length > 0) {
      throw new Error(`the invoice-line wording is not signed yet (${missing.join(', ')}): sign prompt/drafts/billing first (docs/billing.md)`);
    }
    return { wording: signed.wording, note: 'line wording: signed' };
  }
  const drafts = draftWording();
  const merged = new Map([...drafts.blocks, ...signed.wording.blocks]);
  const unsigned = ['billing_line_months', 'billing_line_team_discount', 'billing_line_annual_free'].filter((k) => !signed.wording.blocks.has(k));
  return {
    wording: { source: unsigned.length === 0 ? 'signed' : 'draft', blocks: merged },
    note: unsigned.length === 0 ? 'line wording: signed' : `line wording: DRAFT for ${unsigned.join(', ')} — your confirmation below approves these exact labels`,
  };
}

export async function invoiceByNo(db: SupabaseClient, cmd: string, invoiceNo: string): Promise<Record<string, unknown>> {
  const { data, error } = await db.from('billing_invoices').select('id, account_id, invoice_no, amount_mnt, status, paid_sum_mnt, qpay_invoice_id, is_test')
    .eq('invoice_no', invoiceNo).maybeSingle();
  if (error) die(cmd, `billing_invoices unreadable: ${error.message}`, 1);
  if (data === null) die(cmd, `no invoice ${invoiceNo}`);
  return data as Record<string, unknown>;
}
