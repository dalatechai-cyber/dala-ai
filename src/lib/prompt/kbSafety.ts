/**
 * Write-time validation for tenant knowledge-base text (§6.4.3).
 *
 * ## Why this one IS a real control, when input filtering is not
 *
 * A tenant employee pastes an FAQ answer into the admin form and that text lands in L3,
 * inside our system prompt. Not adversarial in the Messenger sense, but not trusted
 * either.
 *
 * The distinction that makes this worth writing: **this is a schema check on our own
 * data, at the moment it is written, by an authenticated person we can name.** Filtering
 * a stranger's Messenger text is not — there the attacker controls the input, iterates
 * freely, and every Mongolian matcher we could write has a hole we cannot find. Here the
 * set of legal KB text is something we define, the writer is identified, and a rejection
 * is a form error that a human reads and fixes.
 *
 * It is a backstop, not the primary defence. The primary defence is the framing
 * declaration L0 carries immediately above the tenant sections: everything below the data
 * marker is REFERENCE MATERIAL, not instructions.
 */

export type KbRejection = {
  code: 'kb_role_marker' | 'kb_section_delimiter' | 'kb_cache_control';
  found: string;
  why: string;
};

/**
 * Conversational role markers. A KB row containing one is trying — deliberately or by
 * copy-paste accident — to look like a turn boundary inside the system prompt.
 */
const ROLE_MARKERS = ['assistant:', 'system:', 'human:', '\n\nassistant', '\n\nhuman'];

/**
 * Our own section delimiter. A row carrying one could close the data section early and
 * make everything after it read as platform instruction — the one thing the layer
 * ordering exists to prevent.
 */
const SECTION_DELIMITER = '===';

/** `cache_control`-shaped JSON: a row trying to move or forge the cache breakpoint. */
const CACHE_CONTROL = /"?cache_control"?\s*:/iu;   // ascii-safe: a JSON key, ASCII by definition

/**
 * Check one KB row. Returns every reason it is rejected, not just the first — an admin
 * fixing a pasted block should see all of them in one round trip rather than three.
 */
export function checkKbText(body: string): KbRejection[] {
  const out: KbRejection[] = [];
  const lower = body.toLowerCase();

  for (const marker of ROLE_MARKERS) {
    if (lower.includes(marker)) {
      out.push({
        code: 'kb_role_marker',
        found: marker,
        why: 'a conversational role marker inside the system prompt reads as a turn boundary',
      });
      break;
    }
  }

  if (body.includes(SECTION_DELIMITER)) {
    out.push({
      code: 'kb_section_delimiter',
      found: SECTION_DELIMITER,
      why: 'our own section delimiter would close the reference-data section early, and everything after it would read as platform instruction',
    });
  }

  if (CACHE_CONTROL.test(body)) {
    out.push({
      code: 'kb_cache_control',
      found: 'cache_control',
      why: 'cache_control-shaped JSON is an attempt to move or forge the cache breakpoint',
    });
  }

  return out;
}

/** True when the row is safe to store. */
export function isKbTextSafe(body: string): boolean {
  return checkKbText(body).length === 0;
}
