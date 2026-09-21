/**
 * The matcher a provisioned row actually gets — built in ONE place.
 *
 * `comment_rules` carry their matcher in the intake document, so the validator could read
 * the same jsonb the writer would store and `parseMatcher` it. `out_of_scope_topics` do
 * not: the document holds a bare `stems` array and the WRITER manufactures the matcher
 * around it. So there was nothing in the document to validate, and nothing validated it.
 *
 * That cost Matrix a live outage on 2026-09-21 (D-108). `apply.ts` wrote
 * `{ stems: [...] }` with no `mode`; `parseMatcher` has required an explicit mode since
 * the gate was first drafted and answered `unknown matcher mode undefined`; the worker
 * fails closed on an unusable rule, so EVERY direct message for that tenant 503'd. It
 * surfaced sixty seconds after the cutover, on the founder's own test message.
 *
 * `validate.ts` states the principle exactly, twenty lines above where it applies it:
 *
 *   > Validated with `parseMatcher`, the SAME function that runs the rule at request
 *   > time. A provisioning-only validator would be a second reader of one jsonb, free to
 *   > disagree with the first — and the direction it would disagree in is "accepted here,
 *   > refuses the whole job there", which is a tenant switched on and silently unable to
 *   > answer.
 *
 * It was right, and it was applied to the table that happened to have the value in hand.
 * **A validator can only check a value that exists.** Where the writer manufactures one,
 * the manufacture has to be shared or the check has nothing to bite on — which is why this
 * is a module and not a literal inside the upsert.
 */

/**
 * The `out_of_scope_topics.matcher` for an intake rule's stems.
 *
 * `contains_stem` is not a new decision: it is what an absent mode used to be READ as
 * before the parser required one, so a row built here behaves as the rows written before
 * it did. Changing this changes live tenants' behaviour, so it changes with a migration
 * and a republish, not as a default.
 */
export function topicMatcher(stems: readonly string[]): { mode: 'contains_stem'; stems: string[] } {
  return { mode: 'contains_stem', stems: [...stems] };
}
