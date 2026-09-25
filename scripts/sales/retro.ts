/**
 * The sales shadow, run over last week's REAL conversations (D-127).
 *
 *     node scripts/sales/retro.ts            # prints the report's tables (markdown)
 *
 * Reads `corpus.part1.jsonl` + `corpus.part2.jsonl` — every inbound DM on both Facebook
 * channels for seven days, pulled read-only from the live project with the reply facts the
 * decision needs already computed in SQL (see `corpus.meta.json`) — and runs the SAME
 * `decide` the live hook runs, message by message, carrying the conversation's state
 * (offered already? lead already?) exactly as the live hook reads it from `quality_flags`.
 *
 * Nothing is read from or written to any database here. Phone numbers are masked in every
 * quoted message (`maskPhonesInText`), including the tenant's own.
 */
import { readFileSync } from 'node:fs';
import { decide, parsePlaybook, type Decision, type Playbook, type ReplyFacts } from '../../src/lib/sales/nextStep.ts';
import { maskPhonesInText, publishedNumbers } from '../../src/lib/sales/phone.ts';
import { wholeMessageMatches } from '../../src/lib/mn/match.ts';
import { servicesFromPrefix } from '../../src/lib/quality/serviceNames.ts';
import { SECTION_LABELS } from '../../src/lib/prompt/tenant.ts';
import type { CommentRule } from '../../src/lib/comments/classify.ts';

type Row = [string, 'T' | 'D', string, string, string, string, boolean, boolean, boolean, string, boolean];

export type RetroTurn = {
  conversation: string;
  tenant: 'T' | 'D';
  at: string;
  /** The customer's words, phones masked. */
  quoted: string;
  replyState: string;
  decision: Decision;
};

type Meta = {
  tenants: Record<'T' | 'D', {
    template: string; ownTexts: string[]; priceList: string; demoLink: string | null; smallTalkPhrases: string[];
  }>;
};

const here = (f: string): URL => new URL(f, import.meta.url);

export function loadCorpus(): Row[] {
  return ['./corpus.part1.jsonl', './corpus.part2.jsonl']
    .flatMap((f) => readFileSync(here(f), 'utf8').split('\n').filter((l) => l.trim() !== ''))
    .map((l) => JSON.parse(l) as Row);
}

function playbookFor(template: string, demoLink: string | null): Playbook {
  const doc = JSON.parse(readFileSync(here(`../provision/templates/sales_playbook.${template}.json`), 'utf8')) as {
    lead_route: string;
    steps: { kind: string; priority: number; is_default: boolean; intent_matcher: unknown; link_from?: string }[];
    pairings: { service_name: string; related_name: string }[];
  };
  const parsed = parsePlaybook({
    mode: 'shadow',
    lead_route: doc.lead_route,
    steps: doc.steps.map((s) => ({
      ...s, body: null, reviewed_at: null, enabled: true,
      link: s.link_from === 'argument' ? demoLink : null,
    })),
    pairings: doc.pairings.map((p) => ({ ...p, enabled: true, provenance: 'seeded' })),
  });
  if (!parsed.ok) throw new Error(parsed.detail);
  return parsed.playbook;
}

function complaintRulesFor(template: string): CommentRule[] {
  const doc = JSON.parse(readFileSync(here(`../provision/templates/comment_rules.${template}.json`), 'utf8')) as {
    rules: { rule_key: string; verdict: string; matcher: unknown }[];
  };
  return doc.rules.filter((r) => r.verdict === 'escalate')
    .map((r) => ({ ruleKey: r.rule_key, verdict: 'escalate' as const, matcher: r.matcher }));
}

export function runRetro(): RetroTurn[] {
  const meta = JSON.parse(readFileSync(here('./corpus.meta.json'), 'utf8')) as Meta;
  const setup = Object.fromEntries((['T', 'D'] as const).map((t) => {
    const m = meta.tenants[t];
    return [t, {
      playbook: playbookFor(m.template, m.demoLink),
      complaintRules: complaintRulesFor(m.template),
      ownNumbers: publishedNumbers(m.ownTexts),
      serviceNames: m.priceList === '' ? [] : servicesFromPrefix(m.priceList, SECTION_LABELS.priceList).map((s) => s.name),
      smallTalk: m.smallTalkPhrases,
    }];
  })) as Record<'T' | 'D', {
    playbook: Playbook; complaintRules: CommentRule[]; ownNumbers: string[]; serviceNames: string[]; smallTalk: string[];
  }>;

  const out: RetroTurn[] = [];
  const state = new Map<string, { earlier: string[]; offered: boolean; lead: boolean; related: boolean }>();
  for (const [conv, tenant, at, text, replyState, kinds, smallTalk, asks, link, , personBefore] of loadCorpus()) {
    const s = state.get(conv) ?? { earlier: [], offered: false, lead: false, related: false };
    const reply: ReplyFacts = replyState === 'none'
      ? { exists: false }
      : {
          exists: true,
          cannedKinds: kinds === '' ? [] : kinds.split(','),
          refusal: false,
          asksQuestion: asks,
          smallTalk,
          carriesStepLink: link,
        };
    const env = setup[tenant];
    const decision = decide({
      playbook: env.playbook,
      customerMessage: text,
      respelled: null,
      customerSentPhoto: false,
      earlierCustomerMessages: s.earlier,
      reply,
      threadControl: personBefore ? 'human' : 'unknown',
      offeredBefore: s.offered,
      leadBefore: s.lead,
      relatedBefore: s.related,
      customerSmallTalk: env.smallTalk.length > 0 && wholeMessageMatches(text, env.smallTalk),
      complaintRules: env.complaintRules,
      ownNumbers: env.ownNumbers,
      serviceNames: env.serviceNames,
    });
    out.push({ conversation: conv, tenant, at, quoted: maskPhonesInText(text), replyState, decision });
    s.earlier.push(text);
    if (decision.nextStep.verdict === 'offer' || decision.nextStep.verdict === 'in_reply') s.offered = true;
    if (decision.lead.detected) s.lead = true;
    if (decision.related !== null) s.related = true;
    state.set(conv, s);
  }
  return out;
}

/** A customer message for a table cell: exact, phones masked, cut at 70 code points. */
function cell(t: string): string {
  const one = t.replace(/\s*\n\s*/gu, ' / ').replace(/\|/gu, '\\|');
  const cps = [...one];
  return `«${cps.length > 70 ? `${cps.slice(0, 69).join('')}…` : one}»`;
}

function rel(d: Decision): string {
  return d.related === null ? '' : ` + **related** «${d.related.to}» (named «${d.related.from}»)`;
}

function verdictText(d: Decision): string {
  const n = d.nextStep;
  if (n.verdict === 'offer') {
    return `**${n.kind}** (${n.chosenBy === 'intent' ? 'intent words' : 'default'})${rel(d)}`;
  }
  if (n.verdict === 'in_reply') return `already in the reply (link)${rel(d)}`;
  return `— ${n.reason}${rel(d)}`;
}

function main(): void {
  const turns = runRetro();
  const convs = [...new Set(turns.map((t) => t.conversation))];
  for (const tenant of ['D', 'T'] as const) {
    const mine = turns.filter((t) => t.tenant === tenant);
    const cs = [...new Set(mine.map((t) => t.conversation))];
    const offered = cs.filter((c) => mine.some((t) => t.conversation === c && (t.decision.nextStep.verdict === 'offer' || t.decision.nextStep.verdict === 'in_reply')));
    const offers = mine.filter((t) => t.decision.nextStep.verdict === 'offer');
    const byKind = new Map<string, number>();
    for (const t of offers) { const n = t.decision.nextStep; if (n.verdict === 'offer') byKind.set(n.kind, (byKind.get(n.kind) ?? 0) + 1); }
    const reasons = new Map<string, number>();
    for (const t of mine) { const n = t.decision.nextStep; if (n.verdict === 'skip') reasons.set(n.reason, (reasons.get(n.reason) ?? 0) + 1); }
    const leads = mine.filter((t) => t.decision.lead.detected);
    const related = mine.filter((t) => t.decision.related !== null);
    console.log(`\n## ${tenant === 'T' ? 'Tara' : 'DalaTech'}: ${mine.length} messages, ${cs.length} conversations`);
    console.log(`- conversations that would get a next step: ${offered.length} of ${cs.length}`);
    console.log(`- offers: ${offers.length} (${[...byKind].map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}); already in the reply: ${mine.filter((t) => t.decision.nextStep.verdict === 'in_reply').length}`);
    console.log(`- related-service suggestions: ${related.length}`);
    console.log(`- leads (phone in the customer's message): ${leads.length}`);
    console.log(`- no next step, by reason: ${[...reasons].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`).join(', ')}`);
  }
  console.log('\n## Per conversation\n');
  for (const c of convs) {
    const rows = turns.filter((t) => t.conversation === c);
    const first = rows[0];
    if (first === undefined) continue;
    const hit = rows.filter((t) => t.decision.nextStep.verdict === 'offer' || t.decision.nextStep.verdict === 'in_reply'
      || t.decision.lead.detected || t.decision.related !== null);
    const skips = [...new Set(rows.map((t) => (t.decision.nextStep.verdict === 'skip' ? t.decision.nextStep.reason : null)).filter((x) => x !== null))];
    console.log(`**${c}** (${first.tenant === 'T' ? 'Tara' : 'DalaTech'}, ${rows.length} msg, ${first.at}–${rows[rows.length - 1]?.at.slice(6)} UTC)`);
    if (hit.length === 0) {
      console.log(`- no next step: ${skips.join(', ')}\n`);
      continue;
    }
    for (const t of hit) {
      const lead = t.decision.lead.detected ? ` · **lead** ${t.decision.lead.masked.join(', ')}${t.decision.lead.repeat ? ' (repeat)' : ''}` : '';
      console.log(`- ${t.at.slice(6)} ${cell(t.quoted)} → ${verdictText(t.decision)}${lead}`);
    }
    console.log('');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
