/**
 * Where did this row come from? (D-020.)
 *
 * Placeholder `service_aliases` were generated to give the matcher something to chew on —
 * plausible Mongolian phrasings, invented rather than observed. The analysis that was
 * supposed to **validate** them then read them back as tenant data and corrupted its own
 * conclusion. The failure is not that a guess was made. It is that **the guess became
 * indistinguishable from a fact the moment it was written to a row.**
 *
 * `0011` adds the column. This is the half that makes it mean something: D-020's rule is
 * that the mark must survive *into every consumer*, and a column nobody reads is a naming
 * convention with extra steps.
 *
 * ## `null` is not a value here, it is an answer
 *
 * `readProvenance` returns `null` for anything it does not recognise — an absent column, a
 * misspelling, a value from a future migration this build predates. Every consumer treats
 * that exactly as it treats `seeded`, because D-020 says so in as many words: *a consumer
 * that cannot tell must refuse rather than assume.* The opposite reading — "we could not
 * tell, so presumably it is fine" — is the `role_table_grants` bug, which returns empty
 * rather than refusing, and the `schema_migrations` bug, which looks identical whether the
 * migration ran or not.
 *
 * So there is deliberately no `isSeeded()`. The only question a caller may ask is whether
 * a row is confirmed, and every other state answers no.
 */

/** The vocabulary. Matches `<table>_provenance_known` in 0011, and must stay in step. */
export const PROVENANCE_VALUES = ['tenant_confirmed', 'seeded', 'inferred'] as const;

export type Provenance = (typeof PROVENANCE_VALUES)[number];

/** A row's provenance, or `null` when this build cannot tell what the row claims. */
export function readProvenance(raw: unknown): Provenance | null {
  return typeof raw === 'string' && (PROVENANCE_VALUES as readonly string[]).includes(raw)
    ? (raw as Provenance)
    : null;
}

/**
 * The only question worth asking. Exactly `tenant_confirmed` passes; `seeded`, `inferred`,
 * an unknown string, `undefined` and `null` all fail.
 */
export function isTenantConfirmed(raw: unknown): boolean {
  return readProvenance(raw) === 'tenant_confirmed';
}

/**
 * What a consumer reports when it withheld or counted something.
 *
 * Names, not a count. "3 FAQs were excluded" sends an operator to a query; "these three
 * questions were excluded" sends them to the rows. Sorted, because this reaches a
 * `quality_flags` row and an unstable order makes two identical events look different.
 */
export function unconfirmedNames(names: readonly string[]): string[] {
  return [...new Set(names.filter((n) => n !== ''))].sort();
}
