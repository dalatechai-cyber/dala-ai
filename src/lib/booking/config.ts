/**
 * In-chat booking: the per-tenant configuration (`booking_config`, 0082) and the platform
 * switch (`BOOKING_MODE`). Design: `docs/proposals/tara-inchat-booking.md`.
 *
 * A client is rows (CLAUDE.md): the services, their minutes, the stylists and their calendars,
 * the deposits, the agreement sentence and the QPay merchant are all in the tenant's row,
 * copied from the tenant's own booking rules. Nothing here knows a tenant.
 *
 * ## Off unless everything says on
 *
 * The flow runs for a customer only when ALL of these hold: `BOOKING_MODE` is `test` or
 * `live`; the tenant has a row whose `mode` is not `off`; the row's `config` validates here;
 * in `test` mode (row or environment), the customer is one of `test_sender_ids`. A row that
 * does not validate is OFF, with the reason, never partly on: a booking flow with a missing
 * deposit or a stylist without a calendar would take money for a time nobody can see.
 */
import { matcherFires, parseMatcher, type MatcherSpec, type MatchSubject } from '../gate/match.ts';

export type BookingMode = 'off' | 'test' | 'live';

/** The platform switch. Unset or anything else: off, for every tenant. */
export function bookingEnvMode(raw: string | undefined = process.env['BOOKING_MODE']): BookingMode {
  const v = (raw ?? '').trim();
  return v === 'test' || v === 'live' ? v : 'off';
}

export type Gender = 'female' | 'male';

export type Level = { key: string; label: string; depositMnt: number };
export type Stylist = { name: string; label: string; level: string; gender: Gender; calendarId: string };
/** `name` goes into the calendar and the messages; `label` (≤ 20 characters) is the button. */
export type Service = { name: string; label: string; minutes: number };
export type ServiceGroup = { label: string; services: Service[] };
export type QpayMerchant = {
  merchantId: string;
  mccCode: string;
  bankAccounts: { bankCode: string; accountNumber: string; accountName: string }[];
};

export type BookingConfig = {
  testSenderIds: string[];
  holdMinutes: number;
  qrMinutes: number;
  slotStepMinutes: number;
  daysAhead: number;
  minLeadMinutes: number;
  /** A woman books a woman stylist, a man a man (the tenant's own rule, when it has one). */
  genderRule: boolean;
  /** The tenant's deposit agreement, verbatim. Recorded on the hold with the time it was accepted. */
  agreementText: string;
  /** What starts the flow: gate matcher specs (`gate/match.ts`), the tenant's own stems; any one fires. */
  entryMatchers: MatcherSpec[];
  levels: Level[];
  stylists: Stylist[];
  serviceGroups: ServiceGroup[];
  qpay: QpayMerchant;
  /** The deposit in test mode. The tenant's website uses 100₮. */
  testDepositMnt: number;
  /** What the confirmation calls the branch («Яармаг»). Absent: the display name's «— Branch» label. */
  branchLabel: string | null;
};

export type ConfigOutcome = { ok: true; config: BookingConfig } | { ok: false; detail: string };

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.normalize('NFC').trim() : null);
const int = (v: unknown, min: number, max: number): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null;

/** Meta's quick-reply title limit. Every label a customer taps must fit. */
export const QUICK_REPLY_TITLE_MAX = 20;
/** Meta's limit on quick replies in one message. */
export const QUICK_REPLIES_MAX = 13;

/** Code points, never UTF-16 units (rule 6). */
const cp = (s: string): number => [...s].length;

/**
 * Validate a `booking_config.config`. Pure; every refusal names the field. Defaults exist only
 * for the timing knobs, and each default is the tenant website's own value.
 */
export function parseBookingConfig(raw: unknown): ConfigOutcome {
  if (!isObj(raw)) return { ok: false, detail: 'config is not an object' };
  const fail = (detail: string): ConfigOutcome => ({ ok: false, detail });

  const testSenderIds = raw['test_sender_ids'] === undefined ? [] : raw['test_sender_ids'];
  if (!Array.isArray(testSenderIds) || testSenderIds.some((s) => str(s) === null)) {
    return fail('test_sender_ids must be a list of PSIDs');
  }
  const knob = (key: string, dflt: number, min: number, max: number): number | null =>
    raw[key] === undefined ? dflt : int(raw[key], min, max);
  const holdMinutes = knob('hold_minutes', 10, 5, 30);
  const qrMinutes = knob('qr_minutes', 5, 1, 30);
  const slotStepMinutes = knob('slot_step_minutes', 60, 15, 240);
  const daysAhead = knob('days_ahead', 7, 1, 30);
  const minLeadMinutes = knob('min_lead_minutes', 0, 0, 24 * 60);
  const testDepositMnt = knob('test_deposit_mnt', 100, 1, 1000);
  for (const [k, v] of Object.entries({ hold_minutes: holdMinutes, qr_minutes: qrMinutes, slot_step_minutes: slotStepMinutes,
    days_ahead: daysAhead, min_lead_minutes: minLeadMinutes, test_deposit_mnt: testDepositMnt })) {
    if (v === null) return fail(`${k} is out of range`);
  }
  if ((qrMinutes as number) > (holdMinutes as number)) return fail('qr_minutes cannot exceed hold_minutes');

  const genderRule = raw['gender_rule'] === undefined ? true : raw['gender_rule'];
  if (typeof genderRule !== 'boolean') return fail('gender_rule must be true or false');

  const branchLabel = raw['branch_label'] === undefined ? null : str(raw['branch_label']);
  if (raw['branch_label'] !== undefined && branchLabel === null) return fail('branch_label, when given, must be text');
  const agreementText = str(raw['agreement_text']);
  if (agreementText === null) return fail('agreement_text is required: the deposit is taken only on the tenant\'s own agreement');

  const matchersRaw = raw['entry_matchers'];
  if (!Array.isArray(matchersRaw) || matchersRaw.length === 0) return fail('entry_matchers must list at least one matcher');
  const entryMatchers: MatcherSpec[] = [];
  for (const [i, m] of matchersRaw.entries()) {
    const parsed = parseMatcher(m);
    if (!parsed.ok) return fail(`entry_matchers[${i}]: ${parsed.detail}`);
    entryMatchers.push(parsed.spec);
  }

  const levelsRaw = raw['levels'];
  if (!Array.isArray(levelsRaw) || levelsRaw.length === 0) return fail('levels must list at least one level');
  const levels: Level[] = [];
  for (const [i, l] of levelsRaw.entries()) {
    if (!isObj(l)) return fail(`levels[${i}] is not an object`);
    const key = str(l['key']);
    const label = str(l['label']);
    const depositMnt = int(l['deposit_mnt'], 1, 10_000_000);
    if (key === null || label === null || depositMnt === null) return fail(`levels[${i}] needs key, label and a whole deposit_mnt`);
    if (levels.some((x) => x.key === key)) return fail(`levels[${i}]: key ${key} repeats`);
    levels.push({ key, label, depositMnt });
  }

  const stylistsRaw = raw['stylists'];
  if (!Array.isArray(stylistsRaw) || stylistsRaw.length === 0) return fail('stylists must list at least one stylist');
  const stylists: Stylist[] = [];
  for (const [i, s] of stylistsRaw.entries()) {
    if (!isObj(s)) return fail(`stylists[${i}] is not an object`);
    const name = str(s['name']);
    const label = str(s['label']) ?? name;
    const level = str(s['level']);
    const gender = s['gender'];
    const calendarId = str(s['calendar_id']);
    if (name === null || label === null || level === null || calendarId === null) {
      return fail(`stylists[${i}] needs name, level and calendar_id`);
    }
    if (gender !== 'female' && gender !== 'male') return fail(`stylists[${i}].gender must be female or male (never guessed)`);
    if (!levels.some((l) => l.key === level)) return fail(`stylists[${i}].level ${level} is not a listed level`);
    if (stylists.some((x) => x.calendarId === calendarId)) return fail(`stylists[${i}]: calendar_id is used twice`);
    if (stylists.some((x) => x.label === label)) return fail(`stylists[${i}]: label ${label} repeats`);
    stylists.push({ name, label, level, gender, calendarId });
  }

  const groupsRaw = raw['service_groups'];
  if (!Array.isArray(groupsRaw) || groupsRaw.length === 0) return fail('service_groups must list at least one group');
  if (groupsRaw.length > QUICK_REPLIES_MAX - 1) return fail(`at most ${QUICK_REPLIES_MAX - 1} service groups (one button is «cancel»)`);
  const serviceGroups: ServiceGroup[] = [];
  const seen = new Set<string>();
  for (const [i, g] of groupsRaw.entries()) {
    if (!isObj(g)) return fail(`service_groups[${i}] is not an object`);
    const label = str(g['label']);
    const services = g['services'];
    if (label === null || !Array.isArray(services) || services.length === 0) return fail(`service_groups[${i}] needs a label and services`);
    if (cp(label) > QUICK_REPLY_TITLE_MAX) return fail(`service_groups[${i}].label is longer than ${QUICK_REPLY_TITLE_MAX} characters`);
    if (services.length > QUICK_REPLIES_MAX - 1) return fail(`service_groups[${i}] has more than ${QUICK_REPLIES_MAX - 1} services`);
    const list: Service[] = [];
    for (const [j, s] of services.entries()) {
      if (!isObj(s)) return fail(`service_groups[${i}].services[${j}] is not an object`);
      const name = str(s['name']);
      const label = s['label'] === undefined ? name : str(s['label']);
      const minutes = int(s['minutes'], 5, 720);
      if (name === null || label === null || minutes === null) return fail(`service_groups[${i}].services[${j}] needs name and minutes (5–720)`);
      if (cp(label) > QUICK_REPLY_TITLE_MAX) return fail(`service ${name}: its button is longer than ${QUICK_REPLY_TITLE_MAX} characters; give it a label`);
      if (seen.has(name) || seen.has(`label:${label}`)) return fail(`service ${name} (or its label) is listed twice`);
      seen.add(name);
      seen.add(`label:${label}`);
      list.push({ name, label, minutes });
    }
    serviceGroups.push({ label, services: list });
  }

  const q = raw['qpay'];
  if (!isObj(q)) return fail('qpay is required: the tenant\'s own merchant');
  const merchantId = str(q['merchant_id']);
  const mccCode = str(q['mcc_code']);
  const banks = q['bank_accounts'];
  if (merchantId === null || mccCode === null || !/^\d{4}$/u.test(mccCode)) return fail('qpay needs merchant_id and a four-digit mcc_code');
  if (!Array.isArray(banks) || banks.length !== 1) return fail('qpay.bank_accounts must hold exactly one account (the tenant\'s)');
  const bankAccounts: QpayMerchant['bankAccounts'] = [];
  for (const b of banks) {
    if (!isObj(b)) return fail('qpay.bank_accounts[0] is not an object');
    const bankCode = str(b['bank_code']);
    const accountNumber = str(b['account_number']);
    const accountName = str(b['account_name']);
    if (bankCode === null || accountNumber === null || accountName === null) return fail('qpay.bank_accounts[0] needs bank_code, account_number, account_name');
    bankAccounts.push({ bankCode, accountNumber, accountName });
  }

  // Every stylist's button must fit, and no two buttons may read the same.
  const buttons = new Set<string>();
  for (const s of stylists) {
    const level = levels.find((l) => l.key === s.level) as Level;
    const b = stylistButton(s, level);
    if (cp(b) > QUICK_REPLY_TITLE_MAX) return fail(`stylist button «${b}» is longer than ${QUICK_REPLY_TITLE_MAX} characters; set a shorter label`);
    if (buttons.has(b)) return fail(`two stylists would show the same button «${b}»`);
    buttons.add(b);
  }

  return {
    ok: true,
    config: {
      testSenderIds: (testSenderIds as string[]).map((s) => s.trim()),
      holdMinutes: holdMinutes as number,
      qrMinutes: qrMinutes as number,
      slotStepMinutes: slotStepMinutes as number,
      daysAhead: daysAhead as number,
      minLeadMinutes: minLeadMinutes as number,
      genderRule,
      agreementText,
      entryMatchers,
      levels,
      stylists,
      serviceGroups,
      qpay: { merchantId, mccCode, bankAccounts },
      testDepositMnt: testDepositMnt as number,
      branchLabel,
    },
  };
}

/**
 * «Оюунаа · Мастер»: the stylist's own label and level, as one button. When the two do not
 * fit Meta's 20 characters, the label alone (the level is still said in the pay message and
 * decides the deposit); a label that does not fit alone is refused by the parser.
 */
export function stylistButton(s: Stylist, level: Level): string {
  const both = `${s.label} · ${level.label}`;
  return cp(both) <= QUICK_REPLY_TITLE_MAX ? both : s.label;
}

/** Every service, flattened, in the order the tenant listed them. */
export function allServices(c: BookingConfig): Service[] {
  return c.serviceGroups.flatMap((g) => g.services);
}

/**
 * Is this customer in the flow at all? `off` anywhere is off; `test` anywhere means only the
 * tenant's listed testers. Returns whether it is a test booking (100₮, «ТЕСТ»).
 */
export function customerMode(
  envMode: BookingMode, rowMode: BookingMode, config: BookingConfig, psid: string,
): { on: false } | { on: true; isTest: boolean } {
  if (envMode === 'off' || rowMode === 'off') return { on: false };
  const tester = config.testSenderIds.includes(psid);
  if (envMode === 'test' || rowMode === 'test') return tester ? { on: true, isTest: true } : { on: false };
  return { on: true, isTest: tester };
}

/** The deposit a hold carries: the level's, or the test amount for a tester. */
export function depositFor(c: BookingConfig, levelKey: string, isTest: boolean): number | null {
  if (isTest) return c.testDepositMnt;
  return c.levels.find((l) => l.key === levelKey)?.depositMnt ?? null;
}

/** Does this message start a booking? Any one of the tenant's entry matchers. */
export function entryFires(c: BookingConfig, subject: MatchSubject): boolean {
  return c.entryMatchers.some((m) => matcherFires(subject, m));
}
