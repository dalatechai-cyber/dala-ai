/**
 * Build a tenant's `booking_config` row from its website's own booking rules, so the chat and
 * the website can never disagree on a deposit, a stylist's calendar, a service's length, the
 * agreement sentence or the QPay merchant. Nothing is invented and nothing sensitive is copied
 * into this repository: the merchant id, the bank account and the calendar ids are read from
 * the website checkout at run time and written only to the output file.
 *
 *     node scripts/booking/from-website.ts --website ../matrix_website --rules config/booking/tara-salon.json \
 *       --slug matrix-eco-salon --stylists "Оюунсүрэн=Оюунаа,Бадамцэцэг=Бадмаа,Ананд,Уранчимэг,Батзаяа,Уянга,Отгонжаргал" \
 *       [--tester <your PSID>] --out /tmp/booking-matrix-eco-salon.sql
 *
 * `--stylists` is THIS branch's bookable stylists, by the website's Cyrillic key, each with an
 * optional short label (the button shows «label · level»). A stylist the website does not know
 * is refused. Reads the website's `config/stylists.js`, `data/serviceDurations.json`,
 * `services/bookingRules.js` (the agreement) and `api/qpay/create-payment.js` (the merchant).
 *
 * Writes one SQL statement that inserts the row with mode 'off'. Prints a summary with the
 * sensitive values withheld. Validates with the same parser the platform uses, and refuses
 * when any website service is missing from the groups or a group names a service the website
 * does not have. Touches no database.
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseBookingConfig } from '../../src/lib/booking/config.ts';

function die(m: string): never { process.stderr.write(`from-website: ${m}\n`); process.exit(2); }
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? undefined : process.argv[i + 1]; };

const website = path.resolve(arg('website') ?? die('--website <matrix_website checkout> is required'));
const rulesPath = arg('rules') ?? die('--rules <config/booking/*.json> is required');
const slug = arg('slug') ?? die('--slug <tenant slug> is required');
const stylistArg = arg('stylists') ?? die('--stylists "Name=Label,Name,…" is required (this branch\'s stylists)');
const out = arg('out') ?? die('--out <file.sql> is required');
const tester = arg('tester');
if (!/^[a-z0-9-]+$/u.test(slug)) die('a slug is lower-case letters, digits and dashes');

const require = createRequire(import.meta.url);
const { STYLIST_CONFIG } = require(path.join(website, 'config/stylists.js')) as {
  STYLIST_CONFIG: Record<string, { calendarId: string; price: number; level: string; gender?: string }>;
};
const { DEPOSIT_TERMS_TEXT } = require(path.join(website, 'services/bookingRules.js')) as { DEPOSIT_TERMS_TEXT: string };
const durations = JSON.parse(readFileSync(path.join(website, 'data/serviceDurations.json'), 'utf8')) as {
  services: { name: string; minutes: number }[];
};
const createPayment = readFileSync(path.join(website, 'api/qpay/create-payment.js'), 'utf8');
const rules = JSON.parse(readFileSync(rulesPath, 'utf8')) as Record<string, unknown>;

// --- the merchant, exactly as the live create-payment handler sends it --------------------
const one = (re: RegExp, what: string): string => {
  const all = [...createPayment.matchAll(re)].map((m) => m[1] as string);
  const distinct = [...new Set(all)];
  if (distinct.length !== 1) die(`expected exactly one ${what} in api/qpay/create-payment.js, found ${distinct.length}`);
  return distinct[0] as string;
};
const merchantId = one(/merchant_id:\s*["']([0-9a-f-]{36})["']/gu, 'merchant_id');
const mccCode = one(/mcc_code:\s*["'](\d{4})["']/gu, 'mcc_code');
const bankCode = one(/account_bank_code:\s*["'](\d+)["']/gu, 'account_bank_code');
const accountNumber = one(/account_number:\s*["'](\d+)["']/gu, 'account_number');
const accountName = one(/account_name:\s*["']([^"']+)["']/gu, 'account_name');

// --- levels and stylists ----------------------------------------------------------------
const levelLabels = (rules['level_labels'] ?? {}) as Record<string, string>;
const levelKey = (level: string) => (/мастер/iu.test(level) ? 'master' : /1-р/u.test(level) ? 'first' : die(`unknown level ${level}`));
const levels = new Map<string, { key: string; label: string; deposit_mnt: number }>();
const stylists = stylistArg.split(',').map((s) => s.trim()).filter((s) => s !== '').map((entry) => {
  const [name, label] = entry.split('=').map((x) => x.trim()) as [string, string | undefined];
  const s = STYLIST_CONFIG[name];
  if (s === undefined) die(`the website has no stylist ${name}`);
  if (s.gender !== 'female' && s.gender !== 'male') die(`the website has no gender for ${name}; never guessed`);
  const key = levelKey(s.level);
  const prior = levels.get(key);
  if (prior !== undefined && prior.deposit_mnt !== s.price) die(`two deposits for ${s.level}: ${prior.deposit_mnt} and ${s.price}`);
  levels.set(key, { key, label: levelLabels[s.level] ?? die(`no label for level ${s.level} in --rules level_labels`), deposit_mnt: s.price });
  return { name, label: label ?? name, level: key, gender: s.gender, calendar_id: s.calendarId };
});

// --- services: every website service in exactly one group, minutes from the website -------
const minutes = new Map(durations.services.map((s) => [s.name, s.minutes]));
const groups = (rules['service_groups'] as { label: string; services: { name: string; label?: string }[] }[]).map((g) => ({
  label: g.label,
  services: g.services.map((s) => {
    const m = minutes.get(s.name);
    if (m === undefined) die(`group ${g.label} names ${s.name}, which the website does not book`);
    return { name: s.name, minutes: m, ...(s.label === undefined ? {} : { label: s.label }) };
  }),
}));
const grouped = new Set(groups.flatMap((g) => g.services.map((s) => s.name)));
const missing = durations.services.filter((s) => !grouped.has(s.name)).map((s) => s.name);
if (missing.length > 0) die(`website services missing from the groups: ${missing.join(', ')}`);

// --- children's services: names and who serves them from the rules (the tenant's price rows);
// minutes from the rules or the website, never guessed ------------------------------------
const childRaw = (rules['child_services'] ?? []) as { name: string; label?: string; gender: string; minutes?: number }[];
const noMinutes = childRaw.filter((s) => s.minutes === undefined && !minutes.has(s.name)).map((s) => s.name);
if (noMinutes.length > 0) die(`no duration for the children's services: ${noMinutes.join(', ')} (add "minutes" in --rules)`);
const childServices = childRaw.map((s) => ({ name: s.name, gender: s.gender, minutes: s.minutes ?? minutes.get(s.name), ...(s.label === undefined ? {} : { label: s.label }) }));

const config = {
  test_sender_ids: tester === undefined ? [] : [tester],
  hold_minutes: rules['hold_minutes'], slot_step_minutes: rules['slot_step_minutes'],
  days_ahead: rules['days_ahead'], min_lead_minutes: rules['min_lead_minutes'], gender_rule: rules['gender_rule'],
  test_deposit_mnt: rules['test_deposit_mnt'],
  agreement_text: DEPOSIT_TERMS_TEXT,
  entry_matchers: rules['entry_matchers'],
  levels: [...levels.values()],
  stylists,
  service_groups: groups,
  child_services: childServices,
  qpay: { merchant_id: merchantId, mcc_code: mccCode, bank_accounts: [{ bank_code: bankCode, account_number: accountNumber, account_name: accountName }] },
};
const parsed = parseBookingConfig(config);
if (!parsed.ok) die(`the platform would refuse this config: ${parsed.detail}`);

const json = JSON.stringify(config);
if (json.includes('$cfg$')) die('the config contains the SQL quote tag');
writeFileSync(out, `-- booking_config for ${slug}, built ${new Date().toISOString()} from ${website}. Mode OFF.\n`
  + `insert into booking_config (tenant_id, mode, config, updated_by)\nselect id, 'off', $cfg$${json}$cfg$::jsonb, 'from-website'\n`
  + `from tenants where slug = '${slug}'\non conflict (tenant_id) do update set config = excluded.config, updated_at = now(), updated_by = excluded.updated_by;\n`,
{ mode: 0o600 });

const p = parsed.config;
process.stdout.write([
  `booking_config for ${slug} (mode off) written to ${out}`,
  `  levels: ${p.levels.map((l) => `${l.label} ${l.depositMnt}₮`).join(', ')}`,
  `  stylists: ${p.stylists.map((s) => `${s.label} (${s.level}, ${s.gender})`).join(', ')}`,
  `  services: ${p.serviceGroups.map((g) => `${g.label} ${g.services.length}`).join(', ')}`,
  `  QPay: merchant …${merchantId.slice(-4)}, mcc ${mccCode}, bank ${bankCode}, account withheld`,
  `  testers: ${p.testSenderIds.length}`,
  '',
].join('\n'));
