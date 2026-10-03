/**
 * Build one branch's `booking_config` row from the brand's shared booking rules and the brand
 * website's own data, so the chat and the website can never disagree on a service, its minutes,
 * a stylist's calendar, level, gender or deposit, or the branch's QPay merchant. Nothing is
 * invented and nothing sensitive is copied into this repository: calendar ids, the merchant id
 * and the payout account are read at run time and written only to the output file.
 *
 *     node scripts/booking/from-website.ts --website ../matrix_website --rules config/booking/tara-salon.json \
 *       --slug matrix-eco-salon [--tester <your PSID>] --out /tmp/booking-matrix-eco-salon.sql
 *     PARKOD_QPAY_MERCHANT_ID=… PARKOD_QPAY_BANK_CODE=… PARKOD_QPAY_ACCOUNT_NUMBER=… PARKOD_QPAY_ACCOUNT_NAME=… \
 *       node scripts/booking/from-website.ts --website ../matrix_website --rules config/booking/tara-salon.json \
 *       --slug tara-park-od [--qpay-login PARKOD] --out /tmp/booking-tara-park-od.sql
 *
 * `--slug` picks the branch block of `--rules` (an argument: scripts name a tenant only so).
 * Checked against the website, each a refusal:
 *  - services: every service in the rules is a current (non-retired) entry of the website's
 *    `data/serviceDurations.json` with the SAME minutes, and every current entry is in the rules
 *    exactly once (the 62 confirmed durations, founder 2026-10-03);
 *  - stylists: each is in the website's `config/stylists.js` under its `website` key, at this
 *    branch, not retired, with the same gender and level, and the website's deposit for that level
 *    equals the rules' (money: never picked, a disagreement stops the run);
 *  - QPay: `"website"` reads the merchant id from the website's create-payment handler and the
 *    payout account from `config/branches.js` (Яармаг, unchanged); `"operator"` asks the website's
 *    `qpayAccountFor` with the operator's environment (the website's own PARKOD_QPAY_* names), and
 *    is written `"not-connected"` until the merchant and the account are both there. A merchant
 *    id or account equal to another branch's (Яармаг's) is refused.
 * A stylist the website has no calendar for is written `"not-connected"` (the branch stays off).
 * Writes one SQL statement that upserts the row with mode 'off'. Touches no database.
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { allServices, NOT_CONNECTED, parseBookingConfig, QPAY_LOGIN_NAME } from '../../src/lib/booking/config.ts';
import { branchConfig, branchRules, type RawQpay } from '../../src/lib/booking/rules.ts';

function die(m: string): never { process.stderr.write(`from-website: ${m}\n`); process.exit(2); }
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? undefined : process.argv[i + 1]; };

const website = path.resolve(arg('website') ?? die('--website <matrix_website checkout> is required'));
const rulesPath = arg('rules') ?? die('--rules <config/booking/*.json> is required');
const slug = arg('slug') ?? die('--slug <tenant slug> is required');
const out = arg('out') ?? die('--out <file.sql> is required');
const tester = arg('tester');
const qpayLogin = arg('qpay-login');
if (!/^[a-z0-9-]+$/u.test(slug)) die('a slug is lower-case letters, digits and dashes');
if (qpayLogin !== undefined && !QPAY_LOGIN_NAME.test(qpayLogin)) die('--qpay-login is capital letters and digits (BOOKING_QPAY_<login>_*)');

const rules = JSON.parse(readFileSync(rulesPath, 'utf8')) as Record<string, unknown>;
const branch = branchRules(rules, slug);
if (!branch.ok) die(branch.detail);
const b = branch.branch;

const require = createRequire(import.meta.url);
type WebStylist = { calendarId: string | null; price: number; levelKey?: string; gender?: string; branch?: string; retired?: boolean; alias?: boolean };
const { STYLIST_CONFIG } = require(path.join(website, 'config/stylists.js')) as { STYLIST_CONFIG: Record<string, WebStylist> };
const { qpayAccountFor } = require(path.join(website, 'config/branches.js')) as {
  qpayAccountFor: (branch: string) => { merchantId: string | null; bankAccounts: { account_bank_code: string; account_number: string; account_name: string }[] | null } | null;
};
const durations = JSON.parse(readFileSync(path.join(website, 'data/serviceDurations.json'), 'utf8')) as {
  services: { name: string; minutes: number; retired?: boolean }[];
};
const createPayment = readFileSync(path.join(website, 'api/qpay/create-payment.js'), 'utf8');

// --- services and minutes: the rules and the website's current list, exactly ---------------
const current = new Map(durations.services.filter((s) => s.retired !== true).map((s) => [s.name, s.minutes]));

// --- stylists: the founder's list in the rules, checked against the website ---------------
const levels = (rules['levels'] ?? []) as { key: string; deposit_mnt: number }[];
const calendars = new Map<string, string | null>();
for (const s of b.stylists) {
  const w = STYLIST_CONFIG[s.website];
  if (w === undefined || w.alias === true) die(`the website has no stylist ${s.website} (rules: ${s.name})`);
  if (w.retired === true) die(`the website has ${s.website} retired`);
  if (w.branch !== b.website_branch) die(`the website has ${s.website} at ${String(w.branch)}, the rules at ${b.website_branch}`);
  if (w.gender !== s.gender) die(`DISAGREEMENT: ${s.name}'s gender is ${s.gender} in the rules, ${String(w.gender)} on the website (never picked)`);
  if (w.levelKey !== s.level) die(`DISAGREEMENT: ${s.name}'s level is ${s.level} in the rules, ${String(w.levelKey)} on the website (never picked)`);
  const deposit = levels.find((l) => l.key === s.level)?.deposit_mnt;
  if (deposit !== w.price) die(`DISAGREEMENT: the ${s.level} deposit is ${String(deposit)}₮ in the rules, ${w.price}₮ on the website (never picked)`);
  calendars.set(s.website, typeof w.calendarId === 'string' && w.calendarId.trim() !== '' ? w.calendarId.trim() : null);
}

// --- QPay: this branch's own merchant and payout account ----------------------------------
const mcc = [...new Set([...createPayment.matchAll(/mcc_code:\s*["'](\d{4})["']/gu)].map((m) => m[1] as string))];
if (mcc.length !== 1) die(`expected exactly one mcc_code in api/qpay/create-payment.js, found ${mcc.length}`);
/** A branch's merchant id as the website's handler holds it in a constant (`YAARMAG_MERCHANT_ID = "…"`). */
const handlerMerchant = (websiteBranch: string): string | null => {
  const re = new RegExp(`${websiteBranch.toUpperCase()}_MERCHANT_ID\\s*=\\s*["']([0-9a-f-]{36})["']`, 'gu');
  const ids = [...new Set([...createPayment.matchAll(re)].map((m) => m[1] as string))];
  if (ids.length > 1) die(`two ${websiteBranch} merchant ids in api/qpay/create-payment.js`);
  return ids[0] ?? null;
};
const merchantOf = (websiteBranch: string): RawQpay | null => {
  const acct = qpayAccountFor(websiteBranch);
  const merchantId = acct?.merchantId ?? handlerMerchant(websiteBranch);
  const bank = acct?.bankAccounts?.[0];
  if (merchantId === null || merchantId === undefined || bank === undefined) return null;
  return {
    merchant_id: merchantId, mcc_code: mcc[0] as string,
    bank_accounts: [{ bank_code: bank.account_bank_code, account_number: bank.account_number, account_name: bank.account_name }],
    ...(qpayLogin === undefined ? {} : { login: qpayLogin }),
  };
};
const qpay = merchantOf(b.website_branch);
if (b.qpay === 'website' && qpay === null) die(`the website holds no complete QPay merchant for ${b.website_branch}`);
// Never another branch's money: compare with every other branch the rules name.
const others = Object.entries((rules['branches'] ?? {}) as Record<string, { website_branch: string; qpay: string }>)
  .filter(([k, o]) => k !== slug && o.qpay === 'website').map(([, o]) => merchantOf(o.website_branch)).filter((x): x is RawQpay => x !== null);
for (const o of others) {
  if (qpay !== null && (o.merchant_id === qpay.merchant_id || o.bank_accounts[0]?.account_number === qpay.bank_accounts[0]?.account_number)) {
    die('this branch\'s QPay merchant id or payout account is another branch\'s: each branch is paid into its own');
  }
}

const built = branchConfig(rules, slug, {
  calendarFor: (w) => calendars.get(w) ?? null,
  qpay: qpay ?? NOT_CONNECTED,
  ...(tester === undefined ? {} : { testSenderIds: [tester] }),
});
if (!built.ok) die(built.detail);
const parsed = parseBookingConfig(built.config);
if (!parsed.ok) die(`the platform would refuse this config: ${parsed.detail}`);
const p = parsed.config;

const mine = allServices(p);
for (const s of mine) {
  const m = current.get(s.name);
  if (m === undefined) die(`the rules book «${s.name}», which is not on the website's current list`);
  if (m !== s.minutes) die(`DISAGREEMENT: «${s.name}» is ${s.minutes} min in the rules, ${m} on the website`);
}
const missing = [...current.keys()].filter((n) => !mine.some((s) => s.name === n));
if (missing.length > 0) die(`website services missing from the rules: ${missing.join(', ')}`);

const json = JSON.stringify(built.config);
if (json.includes('$cfg$')) die('the config contains the SQL quote tag');
writeFileSync(out, `-- booking_config for ${slug}, built ${new Date().toISOString()} from ${website}. Mode OFF.\n`
  + `insert into booking_config (tenant_id, mode, config, updated_by)\nselect id, 'off', $cfg$${json}$cfg$::jsonb, 'from-website'\n`
  + `from tenants where slug = '${slug}'\non conflict (tenant_id) do update set config = excluded.config, updated_at = now(), updated_by = excluded.updated_by;\n`,
{ mode: 0o600 });

process.stdout.write([
  `booking_config for ${slug} (mode off) written to ${out}`,
  `  levels: ${p.levels.map((l) => `${l.label} ${l.depositMnt}₮`).join(', ')}`,
  `  stylists: ${p.stylists.map((s) => `${s.label} (${s.level}, ${s.gender}${s.calendarId === null ? ', NOT CONNECTED' : ''})`).join(', ')}`,
  `  services: ${mine.length} (${p.serviceGroups.map((g) => `${g.label} ${g.services.length}`).join(', ')}, children ${p.childServices.length})`,
  `  QPay: ${p.qpay === null ? 'NOT CONNECTED' : `merchant …${p.qpay.merchantId.slice(-4)}, mcc ${p.qpay.mccCode}, bank ${p.qpay.bankAccounts[0]?.bankCode ?? '?'}, account withheld, login ${p.qpay.login ?? 'platform (QPAY_*)'}`}`,
  `  ${p.notConnected.length === 0 ? 'connected: the row can be switched to test' : `OFF until connected: ${p.notConnected.join(', ')}`}`,
  `  testers: ${p.testSenderIds.length}`,
  '',
].join('\n'));
