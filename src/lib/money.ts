/**
 * Money is nano-USD, as `bigint`. Never a float, never a plain number.
 *
 * A Haiku cache-read token costs $0.0000001. In `numeric(14,6)` — or in any float
 * accumulation — a per-token price that rounds to nothing produces a ledger that
 * under-reports every single row, and the error is systematic rather than random, so
 * it never averages out. The schema stores `bigint` nano-USD for exactly this reason
 * and this module is the only place the conversion happens.
 *
 * `bigint` rather than `number` because the boundary matters: PostgREST returns a
 * bigint column as a JSON number, which silently loses precision above 2^53. Everything
 * crossing that boundary goes through `fromDb`/`toDb`, which check.
 */

/** Nano-USD. 1 USD = 1_000_000_000n. */
export type NanoUsd = bigint;

export const NANO_PER_USD = 1_000_000_000n;

export function usdToNano(usd: number): NanoUsd {
  if (!Number.isFinite(usd) || usd < 0) throw new RangeError(`not a spendable amount: ${usd}`);
  // Round half-up at the nano, so a compiled ceiling is never silently rounded DOWN
  // into a smaller cap than the one that was reviewed.
  return BigInt(Math.round(usd * 1e9));
}

export function nanoToUsd(nano: NanoUsd): number {
  return Number(nano) / 1e9;
}

/** Human-readable, for alerts and logs. Never used for arithmetic. */
export function formatUsd(nano: NanoUsd): string {
  return `$${(Number(nano) / 1e9).toFixed(4)}`;
}

/**
 * Read a bigint column that arrived as JSON. PostgREST serialises bigint as a JSON
 * number, so anything above 2^53 has ALREADY lost precision by the time we see it —
 * this cannot repair that, only refuse to pretend it did not happen.
 */
export function fromDb(value: unknown, field: string): NanoUsd {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string') {
    if (!/^-?\d+$/.test(value)) throw new TypeError(`${field}: not an integer string: ${value}`); // ascii-safe: numeric column
    return BigInt(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(
        `${field}: ${value} exceeds Number.MAX_SAFE_INTEGER, so precision was already lost in transit. ` +
        `Select this column as text.`);
    }
    return BigInt(value);
  }
  throw new TypeError(`${field}: cannot read as nano-USD: ${typeof value}`);
}

/** Send to the database. Refuses rather than silently truncating. */
export function toDb(nano: NanoUsd): number {
  if (nano > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${nano} nano-USD exceeds what can be sent as a JSON number without loss.`);
  }
  return Number(nano);
}
