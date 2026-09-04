/**
 * Is this deployment configured? One command, one answer per variable.
 *
 *     node scripts/preflight.ts
 *
 * `STATUS.md` §5 lists what the founder has to supply before a real customer message can
 * flow. Four of those items are environment variables, and the way you currently find out
 * one is wrong is that the first webhook 500s — or worse, that nothing happens at all,
 * because a missing `TELEGRAM_BOT_TOKEN` means every alert is recorded and delivered
 * nowhere. This turns that into a checklist you can run before anyone is watching.
 *
 * ## It never prints a value
 *
 * Not a value, not a prefix, not the first four characters. A preflight that echoes a
 * token to prove it read one is a preflight you cannot run in CI, cannot paste into a
 * chat, and cannot leave in a terminal scrollback. Shape only — a length, a key count, a
 * version number.
 *
 * ## It imports the real validators rather than re-deriving them
 *
 * `decodeKeyMaterial` and `parseKekVersion` come from `src/lib/crypto/kek.ts`, and the
 * JSON-map rule from `src/lib/env.ts`. A second copy of "what a valid KEK looks like"
 * would be the §6.2.6 duplication that let `scripts/bakeoff/run.mjs` drift from
 * `config/models.json` — and the copy that drifts is always the one that says "fine".
 *
 * Where no validator exists in `src/`, the check below is a **shape hint** and says so:
 * it can catch a placeholder left in place, and it is not a contract.
 */
import { readFileSync } from 'node:fs';
import { decodeKeyMaterial, parseKekVersion } from '../src/lib/crypto/kek.ts';
import { requiredJsonMap } from '../src/lib/env.ts';

type Verdict = { ok: true; note: string } | { ok: false; why: string };

const present = (v: string | undefined): v is string => v !== undefined && v.trim() !== '';

/** A validator backed by real application code. These are contracts. */
const CONTRACTS: Record<string, (v: string) => Verdict> = {
  DALA_ENV: (v) =>
    ['production', 'staging', 'preview'].includes(v)
      ? { ok: true, note: v }
      : { ok: false, why: 'must be production | staging | preview' },

  TENANT_KEK_V1: (v) => {
    try {
      decodeKeyMaterial(v, 'TENANT_KEK_V1');
      return { ok: true, note: '32 bytes, base64' };
    } catch (e) {
      return { ok: false, why: (e as Error).message };
    }
  },

  TENANT_KEK_ACTIVE_VERSION: (v) => {
    try {
      const n = parseKekVersion(v, 'TENANT_KEK_ACTIVE_VERSION');
      return present(process.env[`TENANT_KEK_V${n}`])
        ? { ok: true, note: `v${n}, and TENANT_KEK_V${n} is set` }
        : { ok: false, why: `names v${n}, but TENANT_KEK_V${n} is not set — nothing could be sealed` };
    } catch (e) {
      return { ok: false, why: (e as Error).message };
    }
  },

  META_APP_SECRETS: (v) => jsonMap('META_APP_SECRETS', v),
  META_VERIFY_TOKENS: (v) => jsonMap('META_VERIFY_TOKENS', v),
};

function jsonMap(name: string, raw: string): Verdict {
  const prior = process.env[name];
  process.env[name] = raw;
  try {
    const map = requiredJsonMap(name);
    const slugs = Object.keys(map);
    if (slugs.length === 0) return { ok: false, why: 'parsed to an empty map — no app is configured' };
    return { ok: true, note: `${slugs.length} app slug(s): ${slugs.join(', ')}` };
  } catch (e) {
    return { ok: false, why: (e as Error).message };
  } finally {
    if (prior === undefined) delete process.env[name];
    else process.env[name] = prior;
  }
}

/** Shape hints. Not contracts — they catch a placeholder, not a wrong value. */
const HINTS: Record<string, (v: string) => Verdict> = {
  NEXT_PUBLIC_SUPABASE_URL: (v) =>
    /^https:\/\/[^\s/]+\.supabase\.co\/?$/.test(v) // ascii-safe: a URL, never user text
      ? { ok: true, note: 'looks like a Supabase project URL' }
      : { ok: false, why: 'expected https://<ref>.supabase.co' },

  META_GRAPH_VERSION: (v) =>
    /^v\d+\.\d+$/.test(v) // ascii-safe: an API version string
      ? { ok: true, note: v }
      : { ok: false, why: 'expected a Graph version such as v21.0' },

  WORKER_PUBLIC_URL: (v) =>
    v.startsWith('https://') && v.includes('/api/workers/reception')
      ? { ok: true, note: 'https, and points at the worker route' }
      : { ok: false, why: 'expected https://<host>/api/workers/reception — QStash must be able to reach it' },

  TELEGRAM_ALERT_CHAT_ID: (v) =>
    /^-?\d+$/.test(v) // ascii-safe: a Telegram numeric chat id
      ? { ok: true, note: 'numeric' }
      : { ok: false, why: "a Telegram chat id is numeric (a group's is negative)" },

  IDENTITY_PEPPER: (v) =>
    v.length >= 32
      ? { ok: true, note: `${v.length} characters` }
      : { ok: false, why: `${v.length} characters; a PSID space is 10^16, so use at least 32 random ones` },

  SUPABASE_SECRET_WEBHOOK: supabaseSecret,
  SUPABASE_SECRET_WORKER: supabaseSecret,
  SUPABASE_SECRET_PRIVACY: supabaseSecret,

  DALA_PUBLIC_URL: (v) => {
    // This value is echoed to Meta and then shown to a member of the public, so a
    // placeholder here is a status URL that goes nowhere for somebody exercising a
    // privacy right. http is refused outright: Meta requires HTTPS for the callback.
    let url: URL;
    try {
      url = new URL(v);
    } catch {
      return { ok: false, why: 'not a URL — expected the deployment origin, e.g. https://dala.mn' };
    }
    if (url.protocol !== 'https:') return { ok: false, why: 'must be https — Meta requires it' };
    if (url.pathname !== '/') return { ok: false, why: 'origin only, with no path' };
    return { ok: true, note: `${url.origin} — status URL ${url.origin}/data-deletion/status` };
  },
};

function supabaseSecret(v: string): Verdict {
  return v.startsWith('sb_secret_')
    ? { ok: true, note: 'sb_secret_…' }
    : { ok: false, why: 'expected an sb_secret_… key. A publishable key here would fail every write' };
}

/** Why each variable matters, in one line, for the report. */
const WHY: Record<string, string> = {
  TELEGRAM_BOT_TOKEN: 'without it every alert is recorded in `alerts` and delivered nowhere',
  TELEGRAM_ALERT_CHAT_ID: 'the same: the condition is detected, nobody is told',
  IDENTITY_PEPPER: 'person_identities.value_hash cannot be computed; inbound persistence refuses',
  TENANT_KEK_V1: 'no credential can be sealed or opened — node scripts/kek/generate.ts',
  ANTHROPIC_API_KEY: 'no reply can be generated',
  QSTASH_TOKEN: 'the webhook cannot hand off; nothing reaches the worker',
  QSTASH_CURRENT_SIGNING_KEY: 'both keys, not one — rotation is why there are two',
  QSTASH_NEXT_SIGNING_KEY: 'both keys, not one — rotation is why there are two',
  SUPABASE_SECRET_PRIVACY: "Meta's data-deletion callback cannot record a request; every one is a 500 and Meta retries",
  DALA_PUBLIC_URL: 'the data-deletion callback cannot build the status URL Meta requires; App Review fails on it',
};

// ---------------------------------------------------------------------------

const src = readFileSync('.env.example', 'utf8');
const required: string[] = [];
const pending: string[] = [];
for (const line of src.split('\n')) {
  const m = /^\s*(#?)\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line);
  if (m === null) continue;
  const commented = m[1] === '#';
  const name = m[2] as string;
  if (/#\s*pending:/.test(line) || commented) pending.push(name);
  else required.push(name);
}

let failures = 0;
const rows: string[] = [];

for (const name of required) {
  const value = process.env[name];
  if (!present(value)) {
    failures += 1;
    const why = WHY[name];
    rows.push(`  MISSING  ${name}${why === undefined ? '' : `\n           ${why}`}`);
    continue;
  }
  const check = CONTRACTS[name] ?? HINTS[name];
  if (check === undefined) {
    rows.push(`  set      ${name}  (${value.length} characters; no format rule to check)`);
    continue;
  }
  const verdict = check(value);
  if (verdict.ok) {
    rows.push(`  ok       ${name}  (${verdict.note})`);
  } else {
    failures += 1;
    rows.push(`  BAD      ${name}\n           ${verdict.why}`);
  }
}

const setPending = pending.filter((n) => present(process.env[n]));

process.stdout.write(`preflight — ${required.length} variables the deployment refuses to serve without\n\n`);
process.stdout.write(`${rows.join('\n')}\n\n`);
if (setPending.length > 0) {
  process.stdout.write(`  also set, and not yet read by anything: ${setPending.join(', ')}\n\n`);
}

if (failures > 0) {
  process.stdout.write(
    `${failures} problem(s). docs/STATUS.md §5 has the ordered list, including which of these\n` +
      `are free and which cost money. Nothing above prints a value, so this output is safe to paste.\n`,
  );
  process.exit(1);
}
process.stdout.write('All required variables are present and well-formed.\n');
process.stdout.write('That is configuration only — it proves nothing about Meta, Supabase, Anthropic or QStash\n');
process.stdout.write('actually answering. docs/STATUS.md §3 is the list of what remains unproven.\n');
