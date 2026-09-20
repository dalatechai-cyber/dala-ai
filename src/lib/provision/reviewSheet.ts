/**
 * Every sentence a customer will read, on one page, for the founder's gate.
 *
 * The gate already exists in two forms — `canned_responses.reviewed_at` for a tenant's own
 * lines and a file hash for platform Mongolian — and both are enforced. What neither
 * provides is the thing a reviewer actually needs: the sentences TOGETHER, in the order a
 * customer might meet them, with the numbers they license printed underneath.
 *
 * That gap is not cosmetic. Matrix's review happened line by line over days, and two of the
 * defects it missed are only visible across lines: every refusal ending at the same phone
 * number nobody was answering (D-076), and the model writing «салонд» one hour and «салон
 * руу» the next against sentences that never settled a register. A reviewer reading one row
 * at a time cannot see either.
 *
 * ## It prints, and it cannot sign
 *
 * Nothing in this file writes. It has no database handle by construction — it takes the
 * document and returns text — so there is no version of it that could set `reviewed_at`.
 * The signature is a human act performed elsewhere, and the sheet exists to make that act
 * informed rather than to shorten it.
 */
import type { IntakeDocument } from './intake.ts';
import type { Finding, Readiness } from './validate.ts';
import { entriesFrom, subsetCollisions, termIsSpecific, toTerm } from '../services/match.ts';

/** The order a customer is most likely to meet these, not alphabetical. */
const SENTENCE_ORDER = [
  'greeting', 'handoff', 'booking_line', 'refusal_price_unlisted', 'refusal_topic',
  'refusal_no_promotion', 'refusal_public_channel', 'image_received', 'out_of_hours',
];

function ordered(kinds: string[]): string[] {
  const rank = (k: string) => {
    const i = SENTENCE_ORDER.indexOf(k);
    return i === -1 ? SENTENCE_ORDER.length : i;
  };
  // Code-point tiebreak, never `localeCompare`: this text is read beside a compiled prompt
  // and ordering that can reach one must not depend on the runtime's locale (D-026).
  return [...kinds].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

export function reviewSheet(
  doc: IntakeDocument,
  ctx: { numbers: readonly string[]; findings: readonly Finding[]; readiness: Readiness },
): string {
  const L: string[] = [];
  const rule = '─'.repeat(72);
  L.push(rule);
  L.push(`REVIEW SHEET — ${doc.business.displayName} (${doc.slug})`);
  L.push(`${Object.keys(doc.sentences).length} sentences · ${doc.services.length} services · readiness: ${ctx.readiness.stage}`);
  L.push(rule);

  L.push('\n1. THE SENTENCES A CUSTOMER WILL READ');
  L.push('   Each is served whole, byte for byte. The model chooses which applies and never');
  L.push('   rewrites one — an adapted line is corrected back to the row (D-065, D-077).');
  const kinds = ordered(Object.keys(doc.sentences));
  if (kinds.length === 0) L.push('\n   (none — this tenant cannot reply at all yet)');
  for (const k of kinds) {
    L.push(`\n   [${k}]`);
    L.push(`   «${doc.sentences[k]}»`);
  }

  // Read them together, which is the thing a row-at-a-time review cannot do.
  const bodies = kinds.map((k) => doc.sentences[k] ?? '');
  const endings = bodies.filter((b) => /\d/.test(b));
  if (endings.length > 1) {
    L.push(`\n   ⚠ ${endings.length} of these carry a number. Matrix's every refusal ended at one`);
    L.push('   phone, and «Утсаа авахгүй байна» — nobody answers — is in its corpus. Read them');
    L.push('   as a set: is this where you want each conversation to stop?');
  }

  L.push('\n2. THE NUMBERS THESE SENTENCES LICENSE');
  L.push(`   allowed_numbers (${ctx.numbers.length}): ${ctx.numbers.join(', ') || '(none)'}`);
  L.push('   The bot may type these and nothing else. Comparison is on the digits alone, so');
  L.push('   `20` does not license `20,000` and half a phone number is refused like an');
  L.push('   invented one. A price is NOT here: prices are served from the row for the');
  L.push('   service the customer named, never from this list (D-075).');
  L.push('   Numerals arrive from every rendered fact, not only from prices — a unit number');
  L.push('   in an address puts that number on the list. That is correct (the tenant said');
  L.push('   it) and it is still a permission: `14` in a street address lets the bot type');
  L.push('   `14` about anything. Read the list as permissions, not as an inventory.');

  L.push('\n3. WHAT THE CLIENT MUST STILL SETTLE');
  const asks = ctx.findings.filter((f) => f.severity === 'ask_client');
  if (asks.length === 0) L.push('   (nothing)');
  for (const f of asks) L.push(`   · ${f.detail}${f.holdsReady === true ? '  ← holds provisioning' : ''}`);

  // Keyed on the name, since an intake document has no service ids yet — the rows do not
  // exist. The collision is a property of the WORDS, so it is knowable before any write,
  // which is the entire point of catching it here rather than at the first customer.
  const collisions = subsetCollisions(entriesFrom(
    doc.services.map((s) => ({ id: s.name, name: s.name })),
    doc.services.flatMap((s) => s.aliases.map((alias) => ({ serviceId: s.name, alias }))),
  ));
  if (collisions.length > 0) {
    L.push('\n   Service names a customer cannot disambiguate:');
    const seenPair = new Set<string>();
    for (const c of collisions) {
      const key = `${c.subset}\u0000${c.superset}`;
      if (seenPair.has(key)) continue;
      seenPair.add(key);
      const terms = [...new Set(collisions
        .filter((o) => o.subset === c.subset && o.superset === c.superset)
        .map((o) => o.via))];
      const vague = terms.filter((v) => !termIsSpecific(toTerm(v)));
      // Naming the TERM, not only the service: «Тэжээлийн тос» is not a subword of «CMC
      // тэжээл» — its alias «тэжээл» is, and the full name resolves perfectly well.
      const via = terms.length === 1 && terms[0] === c.subset ? '' : `  (via «${terms.join('», «')}»)`;
      L.push(`   · «${c.subset}» ⊂ «${c.superset}»${via}`
        + (vague.length > 0 ? `  ← «${vague.join('», «')}» is too short to act on` : ''));
    }
    // The sheet said "until one is renamed the matcher returns `ambiguous` and no price is
    // served" until 2026-09-20, and D-102 had already made that false: a shadowed winner is
    // answered with the whole family. The sentence outlived the behaviour it described by one
    // merge, and the founder caught it in a dry run — a review sheet that misdescribes the
    // code is a gate reading something other than what is served.
    L.push('   The customer is shown EVERY service the short name could mean, each with the');
    L.push('   salon’s own category heading beside its price, and self-selects (D-102).');
    L.push('   A term marked too short above is the exception: nothing at all is served for it.');
  }

  L.push('\n4. WHAT SIGNING MEANS');
  L.push('   Setting `reviewed_at` on a row says: these exact words may be sent to a customer');
  L.push('   of this business, unedited, by a machine, without anyone reading them first.');
  L.push('   Nothing in the provisioning pipeline can set it. A sentence changed later is');
  L.push('   written back UNREVIEWED and the tenant stops replying until it is signed again.');
  L.push(`\n${rule}`);
  return L.join('\n');
}
