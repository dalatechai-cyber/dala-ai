/**
 * In-chat booking: the per-tenant configuration (`booking_config`, 0082) and the platform
 * switch (`BOOKING_MODE`). Design: `docs/proposals/tara-inchat-booking.md`.
 *
 * A client is rows (CLAUDE.md): the services, their minutes, the stylists and their calendars,
 * the deposits and the QPay merchant and payout account are all in the tenant's row, copied from
 * the tenant's own booking rules. Nothing here knows a tenant. A brand's branches are separate
 * tenants, so each branch has its own row: its own stylists, calendars and payout account (D-157).
 *
 * ## Off unless everything says on
 *
 * The flow runs for a customer only when ALL of these hold: `BOOKING_MODE` is `test` or
 * `live`; the tenant has a row whose `mode` is not `off`; the row's `config` validates here;
 * in `test` mode (row or environment), the customer is one of `test_sender_ids`. A row that
 * does not validate is OFF, with the reason, never partly on: a booking flow with a missing
 * deposit or a stylist without a calendar would take money for a time nobody can see.
 *
 * ## «Not connected yet»
 *
 * A branch being prepared names what it does not have yet with the literal `not-connected`: a
 * stylist's `calendar_id` (her calendar is not shared yet) or the whole `qpay` (no payout account
 * of its own yet). Such a row parses, so its shape is checked today, but it is OFF for every
 * customer (`customerMode`, `notConnected`) until every placeholder is replaced. A placeholder is
 * never filled from another branch: there is no fallback anywhere.
 */
import { matcherFires, parseMatcher, type MatcherSpec, type MatchSubject } from '../gate/match.ts';
import { fold } from '../mn/text.ts';

export type BookingMode = 'off' | 'test' | 'live';

/** The platform switch. Unset or anything else: off, for every tenant. */
export function bookingEnvMode(raw: string | undefined = process.env['BOOKING_MODE']): BookingMode {
  const v = (raw ?? '').trim();
  return v === 'test' || v === 'live' ? v : 'off';
}

export type Gender = 'female' | 'male';

export type Level = { key: string; label: string; depositMnt: number };
/**
 * `calendarId` null: not connected yet (the row says `not-connected`); the flow is then off.
 * `aliases`: other spellings a customer may TYPE for this stylist at the stylist question
 * («Отгонжаргал» for Otgonjargal); never shown. Her label alone is always recognised too.
 */
export type Stylist = { name: string; label: string; level: string; gender: Gender; calendarId: string | null; aliases: string[] };
/**
 * `name` goes into the calendar and the messages; `label` (≤ 20 characters) is the button.
 * `level`: only stylists of this level serve it (a price-list line priced per level, «/SPECIAL/»).
 * `family`: services of one group that share a family are ONE button (the family), then their
 * own labels («Богино», «Дунд», «Урт») as a second question, so a long price list fits Meta's 13
 * buttons. Both null for an ordinary service.
 */
export type Service = { name: string; label: string; minutes: number; level: string | null; family: string | null };
/** `audience`: offered only to a booking for this gender (a women's or men's price-list section); null: everyone. */
export type ServiceGroup = { label: string; audience: Gender | null; services: Service[] };
/**
 * A children's service from the tenant's own price list. `gender` says who serves it under the
 * gender rule: a girl's haircut a woman stylist, a boy's a man (the tenant's own rule, read
 * from the service itself, never asked a second time).
 */
export type ChildService = Service & { gender: Gender };
/**
 * The QPay merchant a tenant's deposits are invoiced under and the tenant's OWN payout account:
 * every invoice carries both, on the platform's one Quick QR login (`QPAY_USERNAME/…`, secrets:
 * rule 7). Branches of one brand may share the merchant (Tara: the founder's, both branches,
 * 2026-10-04); what makes a branch's money its own is the payout account (`bank_accounts`), which
 * two tenants never share.
 */
export type QpayMerchant = {
  merchantId: string;
  mccCode: string;
  bankAccounts: { bankCode: string; accountNumber: string; accountName: string }[];
};

/** What a branch being prepared writes where it has nothing yet. Never a usable value. */
export const NOT_CONNECTED = 'not-connected';

export type BookingConfig = {
  testSenderIds: string[];
  /** How long a time is held after its QR is made, and how long that QR is valid: one clock. */
  holdMinutes: number;
  slotStepMinutes: number;
  daysAhead: number;
  minLeadMinutes: number;
  /** A woman books a woman stylist, a man a man (the tenant's own rule, when it has one). */
  genderRule: boolean;
  /** What starts the flow: gate matcher specs (`gate/match.ts`), the tenant's own stems; any one fires. */
  entryMatchers: MatcherSpec[];
  levels: Level[];
  stylists: Stylist[];
  serviceGroups: ServiceGroup[];
  /** «Хүүхэд» on the who-is-it-for question, with these services. Empty: no such button. */
  childServices: ChildService[];
  /** Null: not connected yet (`qpay: "not-connected"`): no invoice is ever made. */
  qpay: QpayMerchant | null;
  /** What is still a `not-connected` placeholder. Non-empty: the flow is off for every customer. */
  notConnected: string[];
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
 * Typed text as the flow compares it with a button or a name: folded, spaces collapsed, end
 * punctuation and quotes dropped. One function for the flow (`turn.ts` sameChoice) and for the
 * parser's check that no typed name picks two stylists, so the two can never disagree.
 */
export const choiceKey = (s: string): string => fold(s).replace(/\s+/gu, ' ').replace(/^[\s«"'(]+|[\s.,!?»"')]+$/gu, '');

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
  // One clock for the time and its QR: the hold lasts exactly as long as the QR is valid (the
  // website's five minutes), so a customer is never shown a QR for a time already let go.
  if (raw['qr_minutes'] !== undefined) return fail('qr_minutes is gone: the QR lasts exactly as long as the hold (hold_minutes)');
  const holdMinutes = knob('hold_minutes', 5, 1, 30);
  const slotStepMinutes = knob('slot_step_minutes', 60, 15, 240);
  const daysAhead = knob('days_ahead', 7, 1, 30);
  const minLeadMinutes = knob('min_lead_minutes', 0, 0, 24 * 60);
  const testDepositMnt = knob('test_deposit_mnt', 100, 1, 1000);
  for (const [k, v] of Object.entries({ hold_minutes: holdMinutes, slot_step_minutes: slotStepMinutes,
    days_ahead: daysAhead, min_lead_minutes: minLeadMinutes, test_deposit_mnt: testDepositMnt })) {
    if (v === null) return fail(`${k} is out of range`);
  }

  const genderRule = raw['gender_rule'] === undefined ? true : raw['gender_rule'];
  if (typeof genderRule !== 'boolean') return fail('gender_rule must be true or false');

  const branchLabel = raw['branch_label'] === undefined ? null : str(raw['branch_label']);
  if (raw['branch_label'] !== undefined && branchLabel === null) return fail('branch_label, when given, must be text');
  // Дали never states the deposit terms in chat (founder, 2026-10-03: the website's tick box says
  // the deposit is non-refundable; the chat must not). The hold records the summary the customer
  // accepted instead (`turn.ts`), so a row still carrying a terms sentence is refused, not ignored.
  if (raw['agreement_text'] !== undefined) return fail('agreement_text is gone: Дали does not state deposit terms in chat; the hold records the summary the customer accepted');

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
    const calendarRaw = str(s['calendar_id']);
    if (name === null || label === null || level === null || calendarRaw === null) {
      return fail(`stylists[${i}] needs name, level and calendar_id (or "${NOT_CONNECTED}")`);
    }
    const calendarId = calendarRaw === NOT_CONNECTED ? null : calendarRaw;
    if (gender !== 'female' && gender !== 'male') return fail(`stylists[${i}].gender must be female or male (never guessed)`);
    if (!levels.some((l) => l.key === level)) return fail(`stylists[${i}].level ${level} is not a listed level`);
    if (calendarId !== null && stylists.some((x) => x.calendarId === calendarId)) return fail(`stylists[${i}]: calendar_id is used twice`);
    if (stylists.some((x) => x.label === label)) return fail(`stylists[${i}]: label ${label} repeats`);
    const aliasesRaw = s['aliases'] === undefined ? [] : s['aliases'];
    if (!Array.isArray(aliasesRaw) || aliasesRaw.some((a) => str(a) === null)) return fail(`stylists[${i}].aliases, when given, is a list of names`);
    const aliases = aliasesRaw.map((a) => str(a) as string);
    stylists.push({ name, label, level, gender, calendarId, aliases });
  }

  const groupsRaw = raw['service_groups'];
  if (!Array.isArray(groupsRaw) || groupsRaw.length === 0) return fail('service_groups must list at least one group');
  if (groupsRaw.length > QUICK_REPLIES_MAX - 1) return fail(`at most ${QUICK_REPLIES_MAX - 1} service groups (one button is «cancel»)`);
  const serviceGroups: ServiceGroup[] = [];
  /** Service names: unique across the whole config (a booking carries the name). */
  const names = new Set<string>();
  const service = (s: unknown, where: string, inGroup: boolean): Service | string => {
    if (!isObj(s)) return `${where} is not an object`;
    const name = str(s['name']);
    const label = s['label'] === undefined ? name : str(s['label']);
    const minutes = int(s['minutes'], 5, 720);
    if (name === null || label === null || minutes === null) return `${where} needs name and minutes (5–720)`;
    if (cp(label) > QUICK_REPLY_TITLE_MAX) return `service ${name}: its button is longer than ${QUICK_REPLY_TITLE_MAX} characters; give it a label`;
    const level = s['level'] === undefined ? null : str(s['level']);
    if (s['level'] !== undefined && (level === null || !levels.some((l) => l.key === level))) return `service ${name}: level ${String(s['level'])} is not a listed level`;
    const family = s['family'] === undefined || !inGroup ? null : str(s['family']);
    if (s['family'] !== undefined && (!inGroup || family === null)) return `service ${name}: family, when given, is text (and only in a group)`;
    if (family !== null && cp(family) > QUICK_REPLY_TITLE_MAX) return `service ${name}: family «${family}» is longer than ${QUICK_REPLY_TITLE_MAX} characters`;
    if (names.has(name)) return `service ${name} is listed twice`;
    names.add(name);
    return { name, label, minutes, level, family };
  };
  for (const [i, g] of groupsRaw.entries()) {
    if (!isObj(g)) return fail(`service_groups[${i}] is not an object`);
    const label = str(g['label']);
    const services = g['services'];
    if (label === null || !Array.isArray(services) || services.length === 0) return fail(`service_groups[${i}] needs a label and services`);
    if (cp(label) > QUICK_REPLY_TITLE_MAX) return fail(`service_groups[${i}].label is longer than ${QUICK_REPLY_TITLE_MAX} characters`);
    if (serviceGroups.some((x) => x.label === label)) return fail(`service_groups[${i}]: label ${label} repeats`);
    const audience = g['audience'] === undefined ? null : g['audience'];
    if (audience !== null && audience !== 'female' && audience !== 'male') return fail(`service_groups[${i}].audience, when given, is female or male`);
    if (audience !== null && !genderRule) return fail(`service_groups[${i}].audience needs gender_rule (who the booking is for is asked only under it)`);
    const list: Service[] = [];
    for (const [j, s] of services.entries()) {
      const parsed = service(s, `service_groups[${i}].services[${j}]`, true);
      if (typeof parsed === 'string') return fail(parsed);
      list.push(parsed);
    }
    // One button per family or ordinary service; the buttons of a group, and the labels inside a
    // family, must each read differently (a typed title must pick exactly one).
    const buttons = new Set<string>();
    for (const s of list) {
      const b = s.family ?? s.label;
      if (s.family === null && buttons.has(b)) return fail(`service_groups[${i}]: two buttons read «${b}»`);
      if (s.family !== null && list.some((x) => x.family === null && x.label === s.family)) return fail(`service_groups[${i}]: family «${s.family}» reads like a service's button`);
      buttons.add(b);
      if (s.family !== null && list.filter((x) => x.family === s.family && x.label === s.label).length > 1) return fail(`service_groups[${i}]: «${s.family}» has two «${s.label}»`);
    }
    if (buttons.size > QUICK_REPLIES_MAX - 1) return fail(`service_groups[${i}] has more than ${QUICK_REPLIES_MAX - 1} buttons`);
    for (const f of new Set(list.map((s) => s.family).filter((x): x is string => x !== null))) {
      if (list.filter((s) => s.family === f).length > QUICK_REPLIES_MAX - 1) return fail(`service_groups[${i}]: «${f}» has more than ${QUICK_REPLIES_MAX - 1} services`);
    }
    serviceGroups.push({ label, audience, services: list });
  }

  const childRaw = raw['child_services'] === undefined ? [] : raw['child_services'];
  if (!Array.isArray(childRaw)) return fail('child_services, when given, must be a list');
  if (childRaw.length > QUICK_REPLIES_MAX - 1) return fail(`at most ${QUICK_REPLIES_MAX - 1} child_services`);
  if (childRaw.length > 0 && !genderRule) return fail('child_services need gender_rule: who serves a child follows the tenant\'s gender rule');
  const childServices: ChildService[] = [];
  for (const [j, s] of childRaw.entries()) {
    const parsed = service(s, `child_services[${j}]`, false);
    if (typeof parsed === 'string') return fail(parsed);
    const gender = isObj(s) ? s['gender'] : undefined;
    if (gender !== 'female' && gender !== 'male') return fail(`child_services[${j}].gender must be female or male (who serves it; never guessed)`);
    if (childServices.some((x) => x.label === parsed.label)) return fail(`child_services[${j}]: label ${parsed.label} repeats`);
    childServices.push({ ...parsed, gender });
  }

  const q = raw['qpay'];
  let qpay: QpayMerchant | null = null;
  if (q !== NOT_CONNECTED) {
    if (!isObj(q)) return fail(`qpay is required: the merchant and the tenant's own payout account (or "${NOT_CONNECTED}" until they are there)`);
    const merchantId = str(q['merchant_id']);
    const mccCode = str(q['mcc_code']);
    const banks = q['bank_accounts'];
    if (merchantId === null || mccCode === null || !/^\d{4}$/u.test(mccCode)) return fail('qpay needs merchant_id and a four-digit mcc_code');
    if (merchantId === NOT_CONNECTED) return fail(`qpay: write "qpay": "${NOT_CONNECTED}" until the merchant and account are there, never a partial qpay`);
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
    // Every tenant's invoices go on the platform's one QPay login; a row naming another is refused,
    // never quietly invoiced on a login it did not name.
    if (q['login'] !== undefined) return fail('qpay.login is not a setting: every tenant invoices on the platform\'s QPay login (QPAY_USERNAME/…)');
    qpay = { merchantId, mccCode, bankAccounts };
  }
  const notConnected = [
    ...stylists.filter((s) => s.calendarId === null).map((s) => `${s.label}'s calendar`),
    ...(qpay === null ? ['the QPay payout account'] : []),
  ];

  // A typed name must pick exactly one stylist: no name or alias may be another stylist's.
  const typedAs = new Map<string, string>();
  for (const st of stylists) {
    for (const n of new Set([st.label, ...st.aliases].map(choiceKey))) {
      if (n === '') return fail(`stylists: ${st.label} has an alias that is only punctuation`);
      const other = typedAs.get(n);
      if (other !== undefined && other !== st.label) return fail(`stylists: «${n}» would name both ${other} and ${st.label}`);
      typedAs.set(n, st.label);
    }
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
      slotStepMinutes: slotStepMinutes as number,
      daysAhead: daysAhead as number,
      minLeadMinutes: minLeadMinutes as number,
      genderRule,
      entryMatchers,
      levels,
      stylists,
      serviceGroups,
      childServices,
      qpay,
      notConnected,
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

/** Every service, flattened, in the order the tenant listed them; the children's last. */
export function allServices(c: BookingConfig): Service[] {
  return [...c.serviceGroups.flatMap((g) => g.services), ...c.childServices];
}

/**
 * Is this customer in the flow at all? `off` anywhere is off; `test` anywhere means only the
 * tenant's listed testers. Returns whether it is a test booking (100₮, «ТЕСТ»).
 */
export function customerMode(
  envMode: BookingMode, rowMode: BookingMode, config: BookingConfig, psid: string,
): { on: false } | { on: true; isTest: boolean } {
  if (envMode === 'off' || rowMode === 'off') return { on: false };
  // A branch with a calendar or its merchant still «not connected» books nobody, testers included:
  // a test booking there would hold a time on no calendar or invoice on no merchant.
  if (config.notConnected.length > 0) return { on: false };
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
