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

/**
 * Every `TENANT_KEK_V<n>`, by PATTERN rather than by name.
 *
 * It was `TENANT_KEK_V1` as a literal key, which was right for exactly as long as there
 * was one key. `TENANT_KEK_V2` is active since 2026-09-21 (D-107) and would have fallen
 * through to "no format rule to check" — so a mistyped key that decodes to the wrong 32
 * bytes passes the deploy and is discovered at the first send, as a row that cannot be
 * opened. The validator is the same one `kekForVersion` uses; what changes is that it now
 * reaches the key a new row is actually sealed under.
 */
function contractFor(name: string): ((v: string) => Verdict) | undefined {
  const named = CONTRACTS[name];
  if (named !== undefined) return named;
  if (!/^TENANT_KEK_V\d+$/.test(name)) return undefined; // ascii-safe: an env var name
  return (v) => {
    try {
      decodeKeyMaterial(v, name);
      return { ok: true, note: '32 bytes, base64' };
    } catch (e) {
      return { ok: false, why: (e as Error).message };
    }
  };
}

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

  // An ORIGIN, with no path. `queue/qstash.ts` builds
  // `${WORKER_PUBLIC_URL}/api/workers/reception`, and STATUS §5 item 8b builds
  // `${WORKER_PUBLIC_URL}/api/workers/health` for the silence watchdog, so the path is
  // appended here and must not already be in the value.
  //
  // This rule used to REQUIRE `/api/workers/reception` in the value, which is the exact
  // opposite. Both halves were wrong and they hid each other: a correct origin was
  // reported BAD, and a value that satisfied the check made QStash post to
  // `…/api/workers/reception/api/workers/reception` — a 404 on every job, with the
  // enqueue succeeding and nothing to see. Found 2026-09-05 by reading the two together;
  // the test asserted the wrong contract too, so the suite was green.
  WORKER_PUBLIC_URL: (v) => {
    let url: URL;
    try {
      url = new URL(v);
    } catch {
      return { ok: false, why: 'not a URL — expected the deployment origin, e.g. https://api.dalatech.online' };
    }
    if (url.protocol !== 'https:') return { ok: false, why: 'must be https — QStash will not call http' };
    if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
      return {
        ok: false,
        why: 'origin only, with no path. The worker path is appended by queue/qstash.ts, so a path '
          + 'here is sent twice and QStash posts to a 404 while the enqueue reports success',
      };
    }
    return { ok: true, note: `${url.origin} — worker ${url.origin}/api/workers/reception` };
  },

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
  TENANT_KEK_V1: 'tenant #0\'s page_token is sealed under v1 and the value cannot be recovered — its absence is permanent data loss, not a config error',
  TENANT_KEK_V2: 'the active version since 2026-09-21: nothing new can be sealed — node scripts/kek/generate.ts',
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
// Marked `# pending:` — documented, and read by nothing yet. Commented-out names WITHOUT the
// marker are OPTIONAL: read by code when set, required by nothing. The two used to share one
// list, so setting an optional variable (DAILY_REPORT_V2, ALERTS_ENABLED) was reported as
// "not yet read by anything" — a false sentence about a variable that is doing its job.
const pending: string[] = [];
for (const line of src.split('\n')) {
  const m = /^\s*(#?)\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line);
  if (m === null) continue;
  const commented = m[1] === '#';
  const name = m[2] as string;
  if (/#\s*pending:/.test(line)) pending.push(name);
  else if (!commented) required.push(name);
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
  const check = contractFor(name) ?? HINTS[name];
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

// ---- Optional variables whose VALUE makes another one required -------------------------
//
// DAILY_REPORT_V2 is optional and stays so (D-128): unset is the old digest exactly. But
// `true` without DAILY_REPORT_SECRET is a report whose DalaTech section reads UNREADABLE
// every morning, and a value that is neither `true` nor `false` — `TRUE`, `1`, `yes` — is
// read as OFF by `dailyReportV2()`, silently. Both are refused here rather than discovered
// at 09:00.
const reportV2 = process.env['DAILY_REPORT_V2'];
if (present(reportV2)) {
  if (reportV2 !== 'true' && reportV2 !== 'false') {
    failures += 1;
    rows.push('  BAD      DAILY_REPORT_V2\n           must be exactly true or false — any other value is read as off, silently');
  } else {
    rows.push(`  ok       DAILY_REPORT_V2  (${reportV2})`);
    if (reportV2 === 'true') {
      const secret = process.env['DAILY_REPORT_SECRET'];
      if (!present(secret)) {
        failures += 1;
        rows.push('  MISSING  DAILY_REPORT_SECRET\n           required because DAILY_REPORT_V2=true: '
          + "without it the report's DalaTech app section reads UNREADABLE every morning");
      } else {
        rows.push(`  ok       DAILY_REPORT_SECRET  (${secret.length} characters; required because DAILY_REPORT_V2=true)`);
      }
    }
  }
}
const sectionUrl = process.env['DAILY_REPORT_SECTION_URL'];
if (present(sectionUrl)) {
  let url: URL | null = null;
  try { url = new URL(sectionUrl); } catch { url = null; }
  if (url === null || url.protocol !== 'https:') {
    failures += 1;
    rows.push('  BAD      DAILY_REPORT_SECTION_URL\n           must be an https URL — the report sends its bearer secret there');
  } else {
    rows.push(`  ok       DAILY_REPORT_SECTION_URL  (${url.origin})`);
  }
}

// ---- The website channel's pair: optional, and read by code when set -----------------
//
// Named explicitly rather than left out, because silence about a variable reads as either
// "fine" or "unused", and both were wrong: `/api/web/session` reads TURNSTILE_SECRET_KEY and
// refuses every visitor while it is unset (fail closed). Absent is EXPECTED until the site
// chatbot moves onto Dala AI — no tenant has a web channel carrying traffic — so it never
// fails the deploy; it just says what its absence means.
const WEB_OPTIONAL: Record<string, string> = {
  TURNSTILE_SECRET_KEY: 'read by /api/web/session; website chat refuses every visitor while unset',
  CLIENT_IP_SALT: 'read by /api/web/session and /api/web/message to hash client IPs',
};
for (const [name, reader] of Object.entries(WEB_OPTIONAL)) {
  rows.push(present(process.env[name])
    ? `  ok       ${name}  (optional, set — ${reader})`
    : `  optional ${name}  unset — expected until the site chatbot moves to Dala AI (${reader})`);
}

const setPending = pending.filter((n) => present(process.env[n]));

process.stdout.write(`preflight — ${required.length} variables the deployment refuses to serve without\n\n`);
process.stdout.write(`${rows.join('\n')}\n\n`);
if (setPending.length > 0) {
  process.stdout.write(`  set, but no code reads it yet (reserved for a later track): ${setPending.join(', ')}\n\n`);
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
