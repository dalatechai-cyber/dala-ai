/**
 * Read the APP-LEVEL webhook subscription out of Meta, for every app secret we hold.
 *
 *     META_APP_SECRETS='{"dalatech":"…"}' \
 *       node scripts/diagnose/meta-subscription.ts \
 *         --app-id 1562862634970492 --app-id 1380702870025418
 *
 * Read-only. It issues GETs and nothing else; there is no flag that writes, and the two
 * Graph writes that could hurt — `POST /{page-id}/subscribed_apps` and the webhook field
 * list — are the two "replacement presented as an addition" traps D-043 catalogues. This
 * command exists so the state can be READ without going near either.
 *
 * ## Why it exists
 *
 * `03-meta-routing.md` §3.10.5 step 2 says webhook delivery needs TWO independent
 * subscriptions: the app must be subscribed to the field on the object, *and* to the
 * specific asset. `POST /{page-id}/subscribed_apps?subscribed_fields=messages` returns
 * `{"success": true}` even when the app has never enabled `messages` on the `page` object,
 * and no events are ever delivered. The page-level read agrees with the tenant config and
 * reports healthy — a plausible success from a source that cannot see the truth.
 *
 * Step 2 was designed and never built. On 2026-09-07 at 01:12 UTC every delivery into this
 * platform stopped — tenant #0's Page and Matrix's Page, both, inside the same hour — and
 * for eleven days nothing in the system could say whether the app-level subscription was
 * still there, because nothing had ever looked. The silence watchdog saw the absence and
 * named the wrong screen. This is the screen.
 *
 * ## The secret is read from the environment, never from an argument
 *
 * Same rule as `scripts/publish/tenant.ts`: command lines are visible in `ps` to every
 * process on the box and land in shell history. The app **id** is a different thing — it is
 * public, it appears in this repository, and it is a flag precisely so that one run can test
 * a secret against several candidate ids.
 *
 * ## Which app does a slug actually name? This answers it as a by-product
 *
 * `META_APP_SECRETS` maps **our** slug to a secret, and D-041 is the record of that slug
 * naming the wrong Meta app in `tenant_channels.app_slug` — a slug is this platform's name
 * for a callback path, not Meta's name for an app. An app access token is literally
 * `{app-id}|{app-secret}`, so it authenticates only against the app the secret belongs to.
 * Running one slug against both candidate ids therefore settles which real app it is, from
 * Meta rather than from a document.
 */
import { requiredJsonMap, required } from '../../src/lib/env.ts';

function die(message: string): never {
  process.stderr.write(`meta-subscription: ${message}\n`);
  process.exit(2);
}

/** Every `--app-id X`, in order, so one run can test a secret against several candidates. */
function appIds(): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] !== '--app-id') continue;
    const value = process.argv[i + 1] ?? '';
    if (!/^[0-9]{6,32}$/.test(value)) die(`--app-id must be a numeric Meta app id, not ${JSON.stringify(value)}`);
    out.push(value);
  }
  return [...new Set(out)];
}

if (process.argv.some((a) => a.startsWith('--secret') || a.startsWith('--app-secret') || a.startsWith('--token'))) {
  die('secrets are read from META_APP_SECRETS in the environment, never from an argument');
}

const ids = appIds();
if (ids.length === 0) {
  die('at least one --app-id is required. CLAUDE.md names two: 1562862634970492 (DALA_AI) and 1380702870025418 (dalatech)');
}

/**
 * The fields the operator expects this app to carry, from `--field`, never a constant.
 *
 * It WAS a constant — `REQUIRED_FIELD = 'messages'`, under a docstring calling it "the
 * field every tenant_channels row on this platform subscribes to today". That sentence
 * stopped being true on 2026-09-20, when Matrix's comment surface needed `feed` and the
 * app-level `feed` toggle went on. A second copy of a fact, drifting, inside the one tool
 * built to catch drift — and the drift it hid is the exact failure D-062 cost eleven days
 * on: this command would have printed `page/messages is subscribed and active` and exited
 * 0 with `feed` switched off and every comment silently undelivered.
 *
 * `tenant_channels.subscribed_fields` is the column that ought to answer this, and it is
 * READ BY NOTHING — written at provisioning and never consulted since, which is D-064's
 * shape and D-072's addendum together. Matrix's row says `{messages}` while Meta has both,
 * so reading it here would have reproduced the same blindness from a different source.
 * Until something reconciles that column against Meta, the honest input is the operator's
 * own expectation, stated per run.
 *
 * REQUIRED, never defaulted, for D-083's reason: a default of `messages` asserts on behalf
 * of an operator who forgot, and the case it gets wrong is the one the flag exists for.
 */
function requiredFields(): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] !== '--field') continue;
    const value = process.argv[i + 1] ?? '';
    // ascii-safe: a Meta webhook field name is Meta's own identifier, never customer text.
    if (!/^[a-z_]{3,40}$/.test(value)) die(`--field must be a Meta webhook field name, not ${JSON.stringify(value)}`);
    out.push(value);
  }
  return [...new Set(out)].sort();
}

const REQUIRED_OBJECT = 'page';
const REQUIRED_FIELDS = requiredFields();
if (REQUIRED_FIELDS.length === 0) {
  die(
    'at least one --field is required, and there is deliberately no default.\n'
    + '  A DM-only channel needs:            --field messages\n'
    + '  A channel answering comments needs: --field messages --field feed\n'
    + '  Sending one alone to Meta REPLACES the set (D-043), so name every field you expect.',
  );
}

const graphVersion = process.env['META_GRAPH_VERSION'] ?? 'v21.0';

// Flatten {slug: secret | secret[]} the same way signature verification does, so this reads
// exactly the set the webhook would accept — including a rotation's second secret.
const secrets: Array<{ slug: string; index: number; secret: string }> = [];
for (const [slug, value] of Object.entries(requiredJsonMap('META_APP_SECRETS'))) {
  const list = Array.isArray(value) ? value : [value];
  list.forEach((secret, index) => {
    if (typeof secret === 'string' && secret !== '') secrets.push({ slug, index, secret });
  });
}
if (secrets.length === 0) die('META_APP_SECRETS parsed to zero usable secrets');

type Subscription = { object?: unknown; callback_url?: unknown; active?: unknown; fields?: unknown };

function fieldNames(fields: unknown): string[] {
  if (!Array.isArray(fields)) return [];
  return fields.map((f) => {
    if (typeof f === 'string') return f;
    if (f !== null && typeof f === 'object' && typeof (f as { name?: unknown }).name === 'string') {
      return (f as { name: string }).name;
    }
    return '';
  }).filter((n) => n !== '');
}

process.stdout.write(`meta-subscription — GET /{app-id}/subscriptions, Graph ${graphVersion}\n`);
process.stdout.write(`${secrets.length} secret(s) in META_APP_SECRETS × ${ids.length} app id(s)\n\n`);

let authenticatedPairs = 0;
let healthyPairs = 0;

for (const { slug, index, secret } of secrets) {
  const label = `META_APP_SECRETS["${slug}"]${index > 0 ? `[${index}]` : ''}`;
  for (const appId of ids) {
    const url = new URL(`https://graph.facebook.com/${graphVersion}/${appId}/subscriptions`);
    // The app access token. Built here and never logged — every write below prints the
    // SLUG and the app id, which are safe, and never the token.
    url.searchParams.set('access_token', `${appId}|${secret}`);

    let status = 0;
    let body: unknown;
    try {
      const res = await fetch(url, { method: 'GET' });
      status = res.status;
      body = await res.json();
    } catch (err) {
      process.stdout.write(`${label} vs app ${appId}: REQUEST FAILED — ${err instanceof Error ? err.message : String(err)}\n\n`);
      continue;
    }

    if (status !== 200) {
      // A 190 / OAuthException here is the NORMAL answer for a secret that belongs to a
      // different app, and it is informative rather than a failure: it is how this command
      // tells you which app a slug actually names.
      const message = (body as { error?: { message?: unknown; code?: unknown } })?.error;
      const detail = typeof message?.message === 'string' ? message.message : JSON.stringify(body);
      process.stdout.write(`${label} vs app ${appId}: HTTP ${status} — not this app's secret, or no access\n`);
      process.stdout.write(`    ${detail}\n\n`);
      continue;
    }

    authenticatedPairs += 1;
    const data = Array.isArray((body as { data?: unknown })?.data) ? ((body as { data: Subscription[] }).data) : [];
    process.stdout.write(`${label} IS app ${appId}. ${data.length} subscribed object(s):\n`);

    if (data.length === 0) {
      // The whole point of this command. An app with no subscriptions delivers nothing to
      // anybody, for every Page at once, with no error anywhere and every page-level read
      // still reporting success.
      process.stdout.write(`    NONE. This app is subscribed to no webhook object at all — it can deliver nothing,\n`);
      process.stdout.write(`    for every Page at once, and no page-level read would show it.\n\n`);
      continue;
    }

    /** Fields this app carries on an ACTIVE `page` subscription. */
    const present = new Set<string>();
    for (const sub of data) {
      const object = typeof sub.object === 'string' ? sub.object : '(no object)';
      const callback = typeof sub.callback_url === 'string' ? sub.callback_url : '(none)';
      const active = sub.active === true;
      const names = fieldNames(sub.fields);
      process.stdout.write(`    object=${object} active=${active} fields=[${names.join(', ')}]\n`);
      process.stdout.write(`      callback_url ${callback}\n`);
      if (object === REQUIRED_OBJECT && active) for (const f of names) present.add(f);
    }
    // Reported PER FIELD rather than as one verdict. A run that says only "not healthy"
    // sends the reader to the App Dashboard without saying which switch to look at, and
    // the two halves fail independently: `messages` can be live while `feed` is off, which
    // is precisely the state this Page was in until 2026-09-20.
    const missing = REQUIRED_FIELDS.filter((f) => !present.has(f));
    for (const f of REQUIRED_FIELDS) {
      process.stdout.write(
        present.has(f)
          ? `    => ${REQUIRED_OBJECT}/${f} is subscribed and active.\n`
          : `    => ${REQUIRED_OBJECT}/${f} is MISSING or INACTIVE. Nothing on that field will be delivered.\n`,
      );
    }
    if (missing.length === 0) healthyPairs += 1;
    process.stdout.write('\n');
  }
}

// ---- what this command cannot see ----------------------------------------
//
// Stated rather than left to be assumed, because the half it cannot reach is the half that
// needs a Page token, and a reader who takes a green run as "the subscription is fine"
// would be making exactly the mistake §3.10.5 step 2 exists to prevent, in the other
// direction.
process.stdout.write('---\n');
process.stdout.write('This reads the APP-LEVEL half only. The page-level half needs a Page token:\n');
process.stdout.write("  curl 'https://graph.facebook.com/" + graphVersion + "/<page-id>/subscribed_apps?access_token=<Page token>'\n");
process.stdout.write('A Page can be granted to an app and still deliver nothing if the app-level field is off;\n');
process.stdout.write('an app-level field can be on and deliver nothing if the Page grant was revoked. Both.\n\n');

if (authenticatedPairs === 0) {
  die('no secret authenticated against any of the app ids given. Either the ids are wrong or the secrets are.');
}
if (healthyPairs === 0) {
  process.stderr.write(
    `meta-subscription: no app carries every requested field on an active ${REQUIRED_OBJECT} subscription `
    + `(${REQUIRED_FIELDS.join(', ')}).\n`,
  );
  process.exit(1);
}
