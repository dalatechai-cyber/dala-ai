/**
 * Every copy of a tenant's facts this project holds, for `checkFactCopies`. A read that
 * fails is `ok: false`, never an empty list: a check that could not read a copy has not
 * shown that copy agrees (rule 9).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { FactCopy, FactService } from './consistency.ts';

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
/** The `body` of every piece in a fixed reply's `items`, parsed or not: a copy is a copy. */
const itemBodies = (v: unknown): string[] => (Array.isArray(v) ? v.map((i) => str(((i ?? {}) as Row)['body'])) : []);

export async function loadFactCopies(
  db: SupabaseClient,
  tenantId: string,
): Promise<{ ok: true; services: FactService[]; copies: FactCopy[] } | { ok: false; detail: string }> {
  const [svc, variants, branch, faqs, fixed, canned, docs] = await Promise.all([
    db.from('services').select('id, name').eq('tenant_id', tenantId).eq('active', true),
    db.from('service_variants').select('id, service_id, price_min, price_max').eq('tenant_id', tenantId),
    db.from('branch_variant_prices').select('variant_id, price_min, price_max').eq('tenant_id', tenantId),
    db.from('faqs').select('question, answer').eq('tenant_id', tenantId),
    db.from('deterministic_replies').select('intent, body, web_body, items').eq('tenant_id', tenantId).eq('enabled', true),
    db.from('canned_responses').select('kind, body').eq('tenant_id', tenantId),
    db.from('knowledge_documents').select('title, body').eq('tenant_id', tenantId),
  ]);
  for (const [name, r] of [['services', svc], ['service_variants', variants], ['branch_variant_prices', branch], ['faqs', faqs],
    ['deterministic_replies', fixed], ['canned_responses', canned], ['knowledge_documents', docs]] as const) {
    if (r.error) return { ok: false, detail: `${name} unreadable: ${r.error.message}` };
  }

  // A branch's own price is a price of the same service, so it may be stated too.
  const amounts = new Map<string, number[]>();
  const serviceOf = new Map<string, string>();
  const add = (serviceId: string, r: Row): void => {
    const list = amounts.get(serviceId) ?? [];
    for (const k of ['price_min', 'price_max']) {
      const n = Number(r[k]);
      if (r[k] !== null && r[k] !== undefined && Number.isFinite(n)) list.push(n);
    }
    amounts.set(serviceId, list);
  };
  for (const v of (variants.data ?? []) as Row[]) {
    serviceOf.set(str(v['id']), str(v['service_id']));
    add(str(v['service_id']), v);
  }
  for (const b of (branch.data ?? []) as Row[]) {
    const sid = serviceOf.get(str(b['variant_id']));
    if (sid !== undefined) add(sid, b);
  }
  const services = ((svc.data ?? []) as Row[]).map((s) => ({ name: str(s['name']), amounts: amounts.get(str(s['id'])) ?? [] }));

  const copies: FactCopy[] = [
    ...((faqs.data ?? []) as Row[]).map((f) => ({ source: `faq «${str(f['question'])}»`, text: `${str(f['question'])}\n${str(f['answer'])}` })),
    // Every piece of a templated reply too, whatever its launch condition (D-154): a price a
    // piece states must agree with the rows in BOTH states, before its switch is ever flipped.
    ...((fixed.data ?? []) as Row[]).map((d) => ({
      source: `fixed reply ${str(d['intent'])}`,
      text: [str(d['body']), str(d['web_body']), ...itemBodies(d['items'])].join('\n'),
    })),
    ...((canned.data ?? []) as Row[]).map((c) => ({ source: `canned ${str(c['kind'])}`, text: str(c['body']) })),
    ...((docs.data ?? []) as Row[]).map((k) => ({ source: `KB «${str(k['title'])}»`, text: `${str(k['title'])}\n${str(k['body'])}` })),
  ];
  return { ok: true, services, copies };
}
