/**
 * Environment access, fail-closed.
 *
 * Two rules from CLAUDE.md are enforced structurally here rather than by discipline:
 *
 *  - Rule 7: secrets come from the environment ONLY, and there is never a fallback to a
 *    default credential. Every accessor below throws on absence. None takes a default.
 *  - Rule 1: there is no `?? DEFAULT_TENANT`. Tenant identity is never read from here.
 *
 * A missing variable throws at the call site rather than at import time, so one
 * unconfigured optional surface cannot stop the whole deployment from booting — but
 * the surface that needs it refuses the moment it is used.
 */

export class MissingEnvError extends Error {
  constructor(name: string) {
    super(
      `Required environment variable ${name} is not set. It has no default and no fallback: ` +
        `see .env.example. Refusing rather than guessing.`,
    );
    this.name = 'MissingEnvError';
  }
}

export function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new MissingEnvError(name);
  return value;
}

/**
 * Parse a JSON map env var such as META_APP_SECRETS.
 *
 * These are deliberately SETS rather than scalars. Meta app secrets and verify tokens
 * must all be valid concurrently, because rotation, staging, and the dala-legacy cutover
 * app each hold a different one and a webhook signed by any of them is genuine. A scalar
 * here would make rotation an outage.
 */
export function requiredJsonMap(name: string): Record<string, string | string[]> {
  const raw = required(name);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be valid JSON (a map of {app_slug: value}). It is not parseable.`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object mapping app_slug to a value.`);
  }
  return parsed as Record<string, string | string[]>;
}

/** Every secret in a JSON-map env var, flattened. Order is not significant. */
export function secretSet(name: string): string[] {
  const out: string[] = [];
  for (const value of Object.values(requiredJsonMap(name))) {
    if (Array.isArray(value)) out.push(...value.filter((v) => typeof v === 'string' && v !== ''));
    else if (typeof value === 'string' && value !== '') out.push(value);
  }
  if (out.length === 0) throw new Error(`${name} parsed to zero usable values. Refusing to accept anything.`);
  return out;
}

export type DalaEnv = 'production' | 'staging' | 'preview';

export function dalaEnv(): DalaEnv {
  const value = required('DALA_ENV');
  if (value !== 'production' && value !== 'staging' && value !== 'preview') {
    throw new Error(`DALA_ENV must be production | staging | preview, not ${JSON.stringify(value)}.`);
  }
  return value;
}
