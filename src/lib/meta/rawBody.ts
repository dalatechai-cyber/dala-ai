/**
 * Read the raw request bytes, bounded.
 *
 * `arrayBuffer()` rather than `text()`: the signature is over bytes, and decoding to
 * UTF-16 and back is byte-identical only for well-formed UTF-8. See signature.ts.
 *
 * The 1 MB cap is ported verbatim from the ancestor (`lib/rawBody.js:10`). An unbounded
 * buffered read is a trivial memory-exhaustion DoS on the one route that must never be
 * slow, and Meta's own payloads are far below this.
 */
export const MAX_BODY_BYTES = 1024 * 1024;

export type RawBodyResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; status: 413 | 400; code: 'webhook.body_too_large' | 'webhook.body_read_failed' };

export async function readRawBody(request: Request): Promise<RawBodyResult> {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > MAX_BODY_BYTES) {
      return { ok: false, status: 413, code: 'webhook.body_too_large' };
    }
  }
  try {
    const bytes = Buffer.from(await request.arrayBuffer());
    // Content-Length is a claim, not a fact. Check the bytes we actually got.
    if (bytes.byteLength > MAX_BODY_BYTES) {
      return { ok: false, status: 413, code: 'webhook.body_too_large' };
    }
    return { ok: true, bytes };
  } catch {
    return { ok: false, status: 400, code: 'webhook.body_read_failed' };
  }
}
