/**
 * The founder's emergency override for the reply-case gate (D-121).
 *
 * Founder, 2026-09-25: *"Add an emergency override to the test gate, for when the database or
 * Anthropic is down and I need a hotfix deployed. Only I can use it, it's logged, and it sends
 * me a Telegram alert every time it's used."*
 *
 * ## What it overrides, and what it never does
 *
 * Only a case that COULD NOT BE CHECKED: the database did not answer, the configuration did
 * not load, the model was unavailable, the check timed out. A case that was checked and
 * answered WRONGLY still stops the deploy, override or not. An outage is a reason not to know;
 * it is never a reason to ship an answer already known to be wrong. That case has its own,
 * visible escape (`reply_cases.active = false`), and it is a decision about the case, not
 * about the deploy.
 *
 * ## Only the founder can use it
 *
 * The override is a token signed with an Ed25519 PRIVATE key that exists only on the
 * founder's machine (`scripts/replycases/override.ts keygen` writes it there with mode 0600).
 * The build verifies it against the PUBLIC keys in `overrideKeys.ts`. Nobody without the
 * private key — a session like this one included — can mint a token. Changing the list of
 * public keys is a commit anyone can read in `git log`.
 *
 * A token names ONE commit (`VERCEL_GIT_COMMIT_SHA`) and expires within
 * `OVERRIDE_MAX_HOURS`. So a token left in the Vercel environment cannot switch the gate off
 * for the next deploy, and one copied out of a build log is useless after the window.
 *
 * ## Every use is announced, or it is not a use
 *
 * The Telegram alert is sent BEFORE the override takes effect, and if it cannot be sent the
 * override is refused. That is what "every time" requires: an override nobody was told about
 * is exactly what this gate exists to prevent. The build log carries the same lines, and an
 * `alerts` row is written when the database answers — best effort, because the database being
 * down is one of the two reasons this exists.
 */
import { createHash, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';

/** The longest a token may live, from `issued` to `until`. */
export const OVERRIDE_MAX_HOURS = 24;
/** Clock skew tolerated on `issued`: a laptop a few minutes fast is not an attack. */
const MAX_SKEW_MS = 5 * 60_000;
const MAX_REASON_CP = 200;
const SHA = /^[0-9a-f]{40}$/u;

export type OverridePayload = { v: 1; sha: string; issued: string; until: string; reason: string };

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

/** The short name a key is logged under: the first 16 hex of the SHA-256 of its SPKI bytes. */
export function keyId(publicKeyB64: string): string {
  return createHash('sha256').update(Buffer.from(publicKeyB64, 'base64')).digest('hex').slice(0, 16);
}

function publicKeyFrom(b64: string): KeyObject | null {
  try {
    return createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
  } catch {
    return null;
  }
}

/** A new key pair: the public half as base64 SPKI, the private half as PEM. */
export function generateOverrideKey(): { publicKey: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  };
}

/** Sign an override for one commit. Throws on a malformed request rather than signing it. */
export function signOverride(
  input: { sha: string; reason: string; now: Date; hours: number },
  privateKeyPem: string,
): string {
  const sha = input.sha.trim().toLowerCase();
  if (!SHA.test(sha)) throw new Error('the commit SHA must be the full 40 hex characters');
  const reason = input.reason.trim();
  if (reason === '' || [...reason].length > MAX_REASON_CP) throw new Error(`a reason of 1–${MAX_REASON_CP} characters is required`);
  if (!(input.hours > 0 && input.hours <= OVERRIDE_MAX_HOURS)) throw new Error(`hours must be above 0 and at most ${OVERRIDE_MAX_HOURS}`);
  const payload: OverridePayload = {
    v: 1, sha, reason,
    issued: input.now.toISOString(),
    until: new Date(input.now.getTime() + input.hours * 60 * 60_000).toISOString(),
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  return `${b64url(body)}.${b64url(sign(null, body, privateKeyPem))}`;
}

export type OverrideCheck =
  | { ok: true; payload: OverridePayload; keyId: string }
  | { ok: false; why: string };

/** Is this token the founder's, for this commit, now? Every refusal says why. */
export function verifyOverride(
  token: string,
  input: { sha: string | undefined; now: Date; publicKeys: readonly string[] },
): OverrideCheck {
  if (input.publicKeys.length === 0) return { ok: false, why: 'no founder key is registered in overrideKeys.ts' };
  const buildSha = (input.sha ?? '').trim().toLowerCase();
  if (!SHA.test(buildSha)) return { ok: false, why: 'the build has no commit SHA (VERCEL_GIT_COMMIT_SHA), so the token cannot be bound to it' };

  const parts = token.trim().split('.');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') return { ok: false, why: 'not a token: expected <payload>.<signature>' };
  const body = Buffer.from(parts[0] as string, 'base64url');
  const sig = Buffer.from(parts[1] as string, 'base64url');

  const signer = input.publicKeys.find((k) => {
    const key = publicKeyFrom(k);
    try {
      return key !== null && verify(null, body, key, sig);
    } catch {
      return false;
    }
  });
  if (signer === undefined) return { ok: false, why: 'the signature is not from a registered founder key' };

  let p: Record<string, unknown>;
  try {
    p = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
  } catch {
    return { ok: false, why: 'the signed payload is not JSON' };
  }
  const reason = typeof p['reason'] === 'string' ? p['reason'].trim() : '';
  const issued = new Date(String(p['issued']));
  const until = new Date(String(p['until']));
  if (p['v'] !== 1 || typeof p['sha'] !== 'string' || reason === '' || Number.isNaN(issued.getTime()) || Number.isNaN(until.getTime())) {
    return { ok: false, why: 'the signed payload is malformed' };
  }
  if (p['sha'] !== buildSha) return { ok: false, why: `the token is for commit ${String(p['sha']).slice(0, 7)}, this build is ${buildSha.slice(0, 7)}` };
  if (until.getTime() <= issued.getTime() || until.getTime() - issued.getTime() > OVERRIDE_MAX_HOURS * 60 * 60_000) {
    return { ok: false, why: `a token may live at most ${OVERRIDE_MAX_HOURS} hours` };
  }
  if (issued.getTime() > input.now.getTime() + MAX_SKEW_MS) return { ok: false, why: 'the token was issued in the future' };
  if (input.now.getTime() > until.getTime()) return { ok: false, why: `the token expired at ${until.toISOString()}` };
  return {
    ok: true,
    keyId: keyId(signer),
    payload: { v: 1, sha: buildSha, issued: issued.toISOString(), until: until.toISOString(), reason },
  };
}

/** What the gate found, sorted into the two things an override treats differently. */
export type GateFindings = {
  /** Checked and answered wrongly. Never overridden. */
  wrong: string[];
  /** Could not be checked. The only thing an override lets through. */
  unchecked: string[];
};

export type Decision = { exit: 0 | 1 | 2; lines: string[] };

/**
 * The gate's verdict with the override applied. `alert` must deliver before the override
 * counts; `record` is the best-effort durable log and never throws.
 */
export async function decide(
  findings: GateFindings,
  input: {
    token: string | undefined;
    sha: string | undefined;
    now: Date;
    publicKeys: readonly string[];
    alert: (text: string) => Promise<{ ok: true } | { ok: false; detail: string }>;
    record: (entry: { body: string; dedupKey: string }) => Promise<string>;
  },
): Promise<Decision> {
  const token = (input.token ?? '').trim();
  if (findings.wrong.length === 0 && findings.unchecked.length === 0) {
    return { exit: 0, lines: [token === '' ? 'reply-cases: every case passes.' : 'reply-cases: every case passes; the override was not needed and was not used.'] };
  }
  if (findings.wrong.length > 0) {
    return {
      exit: 1,
      lines: [
        'reply-cases: a marked reply is answered wrongly. Nothing goes out until it passes.',
        ...(token === '' ? [] : ['reply-cases: the emergency override covers only cases that could not be checked, never a wrong answer. It was not used.']),
      ],
    };
  }
  const notChecked = findings.unchecked.map((u) => `reply-cases: not checked: ${u}`);
  if (token === '') {
    return { exit: 2, lines: [...notChecked, 'reply-cases: cases could not be checked, so nothing goes out. (Emergency: REPLY_GATE_OVERRIDE, D-121.)'] };
  }
  const check = verifyOverride(token, { sha: input.sha, now: input.now, publicKeys: input.publicKeys });
  if (!check.ok) return { exit: 2, lines: [...notChecked, `reply-cases: emergency override REFUSED — ${check.why}.`] };

  const p = check.payload;
  const text = [
    `⚠️ Test gate OVERRIDDEN for deploy ${p.sha.slice(0, 7)}.`,
    `Reason: ${p.reason}`,
    `Could not check: ${findings.unchecked.slice(0, 3).join('; ')}${findings.unchecked.length > 3 ? ` (+${findings.unchecked.length - 3})` : ''}`,
    `Key ${check.keyId}, token valid until ${p.until}.`,
  ].join('\n');
  const sent = await input.alert(text);
  if (!sent.ok) {
    return { exit: 2, lines: [...notChecked, `reply-cases: emergency override REFUSED — the Telegram alert could not be sent (${sent.detail}), and an unannounced override is not one.`] };
  }
  const logged = await input.record({ body: text, dedupKey: `gate_override:${p.sha}:${p.issued}` });
  return {
    exit: 0,
    lines: [
      '################################################################',
      `reply-cases: OVERRIDDEN by the founder's key ${check.keyId} for commit ${p.sha}.`,
      `reply-cases: reason: ${p.reason}`,
      `reply-cases: token valid until ${p.until}; Telegram alert sent; database log: ${logged}.`,
      ...findings.unchecked.map((u) => `reply-cases: not checked: ${u}`),
      '################################################################',
    ],
  };
}
