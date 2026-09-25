/**
 * The founder's public keys for the reply-case gate's emergency override (D-121).
 *
 * Each entry is the base64 SPKI printed by
 * `node scripts/replycases/override.ts keygen` on the FOUNDER'S machine. The private half
 * never leaves it.
 *
 * Empty means the override cannot be used by anyone. That is the state until the founder
 * generates a key and asks for its public half to be added here. Only then may a key be
 * added, and only the one the founder printed. A key added here by anybody else would let its holder
 * switch the gate off, so an entry whose origin is not the founder's own keygen output is a
 * security incident, not a configuration change.
 */
export const FOUNDER_OVERRIDE_KEYS: readonly string[] = [];
