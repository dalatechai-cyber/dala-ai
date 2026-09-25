/**
 * A tenant with ONE location, as Matrix/Tara is on 2026-09-25, and the same tenant after it
 * adds a second branch.
 *
 * Imported by tests only. It lives outside `*.test.ts` for the reason
 * `prompt/tenantKb.fixtures.ts` gives: `node --test` runs every test file a module is
 * imported from.
 *
 * The contact values are the live ones read from production on 2026-09-25 (the task brief):
 * phone «76001888, 80905498», the Google Maps short link, the Яармаг address and the
 * `products.html` website. The SECOND branch is invented for the tests — its name, address,
 * link, phone, hours and prices are placeholders and are not the salon's data. Nothing here
 * is customer-visible: it is test input, never published.
 */
import { createHash } from 'node:crypto';
import { SECTION_LABELS, type TenantKb } from '../prompt/tenant.ts';
import { faqAnswersFromPrefix, sectionRows, servicesFromPrefix } from '../quality/serviceNames.ts';
import type { ReceptionDeps, ReceptionInput, ReceptionOutcome } from '../reception/handle.ts';
import type { CallOutcome } from '../model/reception.ts';

export const HANDOFF = 'Уучлаарай, би энэ асуултад хариулж чадахгүй байна. Та 76001888 эсвэл 80905498 дугаараар холбогдоно уу.';
export const BOOKING_LINE = 'Та манай вэбсайтаар (https://www.matrixecosalon.org/) онлайнаар цаг захиалж, урьдчилгаа төлбөрөө QPay-ээр төлөх боломжтой.';

/** Matrix/Tara today: one location, every fact tenant-wide. */
export const ONE_BRANCH_KB: TenantKb = {
  currencySymbol: '₮',
  currencySymbolBefore: false,
  refusalTopics: [{ key: 'children_services', question: 'Сүүлийн мессеж хүүхдийн үйлчилгээ, үнийн тухай юу?' }],
  clarify: [],
  deposits: ['Мастер үсчин: 20,000₮', '1-р зэргийн үсчин: 10,000₮'],
  documents: [{ title: 'Салбарууд', body: 'Одоогоор нэг салбартай: Яармаг салбар. Удахгүй хоёр дахь салбар нээгдэнэ.' }],
  canned: [
    { kind: 'booking_line', body: BOOKING_LINE },
    { kind: 'handoff', body: HANDOFF },
    { kind: 'image_received', body: 'Уучлаарай, би зураг харах боломжгүй.' },
  ],
  staff: [],
  services: [
    {
      name: 'Усан хими',
      variants: [{ variantKey: '', priceKind: 'range', priceMin: '132000.00', priceMax: '154000.00', refusalTopic: null }],
    },
    {
      name: 'Эмэгтэй тайралт',
      variants: [
        { variantKey: '1-р зэрэг', priceKind: 'exact', priceMin: '25000.00', priceMax: null, refusalTopic: null },
        { variantKey: 'Мастер', priceKind: 'exact', priceMin: '35000.00', priceMax: null, refusalTopic: null },
      ],
    },
    {
      name: 'Үсний угийн будаг',
      variants: [{ variantKey: '', priceKind: 'exact', priceMin: '135000.00', priceMax: null, refusalTopic: null }],
    },
  ],
  faqs: [{ question: 'Зогсоол байдаг уу?', answer: 'Тийм, барилгын урд талд үнэгүй зогсоол бий.' }],
  contacts: [
    { kind: 'address', value: 'Яармагийн Номин Хайпермаркетын баруун талд' },
    { kind: 'maps_url', value: 'https://maps.app.goo.gl/ckEXBLoq4FnxJHq16' },
    { kind: 'phone', value: '76001888, 80905498' },
    { kind: 'website', value: 'https://www.matrixecosalon.org/products.html' },
  ],
  bookingUrl: 'https://www.matrixecosalon.org/',
  hours: [
    { weekday: 0, opens: '11:00:00', closes: '19:00:00', closed: false },
    { weekday: 1, opens: '10:00:00', closes: '20:00:00', closed: false },
    { weekday: 2, opens: '10:00:00', closes: '20:00:00', closed: false },
    { weekday: 3, opens: '10:00:00', closes: '20:00:00', closed: false },
    { weekday: 4, opens: '10:00:00', closes: '20:00:00', closed: false },
    { weekday: 5, opens: '10:00:00', closes: '20:00:00', closed: false },
    { weekday: 6, opens: '10:00:00', closes: '20:00:00', closed: false },
  ],
  branches: [],
};

/**
 * A test-only clarify line. NOT the proposed wording (that is in
 * `prompt/drafts/branch_clarify.mn.txt`, unsigned): a fixture sentence, marked as one.
 */
export const TEST_CLARIFY = 'Аль салбарын талаар асууж байна вэ? (тестийн мөр)';

/** The invented second branch's facts. Placeholders — not the salon's data. */
export const ZAISAN = {
  address: 'Зайсангийн Нарны замын 5-р байрны 1 давхар',
  maps: 'https://maps.app.goo.gl/TestZaisanBranch01',
  phone: '99112233',
};

/**
 * The same tenant with TWO confirmed branches. What differs: the address and map link (both
 * branches), the phone (the second branch has its own), the Sunday hours, and the price of
 * one service variant. What is shared: the website, the booking link, every other price, the
 * deposits.
 */
export const TWO_BRANCH_KB: TenantKb = {
  ...ONE_BRANCH_KB,
  branches: [
    // The first branch keeps every tenant-wide row; it needs no row of its own at all.
    { name: 'Яармаг салбар', contacts: [], hours: [], prices: [] },
    {
      name: 'Зайсан салбар',
      contacts: [
        { kind: 'address', value: ZAISAN.address },
        { kind: 'maps_url', value: ZAISAN.maps },
        { kind: 'phone', value: ZAISAN.phone },
      ],
      hours: [{ weekday: 0, opens: '12:00:00', closes: '18:00:00', closed: false }],
      prices: [{
        service: 'Эмэгтэй тайралт', variantKey: 'Мастер',
        variant: { variantKey: 'Мастер', priceKind: 'exact', priceMin: '40000.00', priceMax: null, refusalTopic: null },
      }],
    },
  ],
};

/** How customers write the two branches, as `tenant_branches.stems` would hold them. */
export const TWO_BRANCH_STEMS = [
  { name: 'Яармаг салбар', stems: ['yarmag', 'iarmag'] },
  { name: 'Зайсан салбар', stems: ['zaisan', 'zaysan'] },
];

/**
 * Customer messages and what a model might write back — the ways a one-location tenant's
 * facts reach a reply: quoted whole, restated, a link, a phone, the week, a greeting.
 */
export const ONE_BRANCH_SCENARIOS: readonly { message: string; reply: string }[] = [
  { message: 'Хаяг хаана вэ?', reply: 'Хаяг: Яармагийн Номин Хайпермаркетын баруун талд' },
  { message: 'hayag haana ve', reply: 'Манай салон Номин Хайпермаркетын баруун талд байдаг.' },
  { message: 'Эмэгтэй тайралт хэд вэ?', reply: 'Эмэгтэй тайралт (1-р зэрэг): 25,000₮\nЭмэгтэй тайралт (Мастер): 35,000₮' },
  { message: 'Мастер тайралт хэд вэ?', reply: 'Мастер тайралт 35 мянган төгрөг.' },
  { message: 'Хэдэн цагт ажилладаг вэ?', reply: 'Бид өдөр бүр 10:00-20:00 цагт ажилладаг.' },
  { message: 'Утас?', reply: 'Та 7600-1888 руу залгаарай.' },
  { message: 'Байршил?', reply: 'Байршлын холбоос: https://maps.app.goo.gl/ckEXBLoq4FnxJHq16' },
  { message: 'Сайн байна уу', reply: 'Сайн байна уу! Танд юугаар туслах вэ?' },
  { message: 'tsag avah', reply: BOOKING_LINE },
  { message: 'Усан хими хэд вэ?', reply: 'Усан хими: 132,000₮–154,000₮' },
];

export type ScenarioOutcome = {
  message: string;
  outcome: string;
  drafts: { body: string; answeredBy: string }[];
  flags: string[];
};

/**
 * Run every scenario through `handleReception` and return what each one drafted, flagged
 * and returned. `input` carries everything but the message and the model's reply.
 */
export async function runScenarios(
  handle: (deps: ReceptionDeps, input: ReceptionInput) => Promise<ReceptionOutcome>,
  input: Omit<ReceptionInput, 'customerMessage'>,
  scenarios: readonly { message: string; reply: string; history?: ReceptionInput['history'] }[],
): Promise<ScenarioOutcome[]> {
  const out: ScenarioOutcome[] = [];
  for (const s of scenarios) {
    const drafts: { body: string; answeredBy: string }[] = [];
    const flags: string[] = [];
    const result: CallOutcome = {
      kind: 'ok', text: s.reply, modelReturned: 'm', stopReason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    };
    const deps: ReceptionDeps = {
      callModel: async () => result,
      draft: async ({ body, answeredBy }) => { drafts.push({ body, answeredBy }); return { ok: true, id: 'om' }; },
      markCalled: async () => true,
      settle: async () => ({ ok: true }),
      release: async () => {},
      flag: async (f) => { flags.push(f.code); },
      observe: async () => {},
    };
    const r = await handle(deps, { ...input, customerMessage: s.message, history: s.history ?? input.history });
    out.push({ message: s.message, outcome: r.kind === 'drafted' ? `drafted:${r.answeredBy}` : r.kind, drafts, flags });
  }
  return out;
}

/**
 * Everything `handleReception` needs besides the message, built from a compiled prefix the
 * way the worker builds it (`app/api/workers/reception/route.ts`): the price list, deposits
 * and FAQ answers read back out of the prefix, the canned rows reviewed.
 */
export function scenarioInput(
  promptStable: string,
  allowedNumbers: readonly string[],
  extra: Partial<ReceptionInput> = {},
): Omit<ReceptionInput, 'customerMessage'> {
  const reviewed = '2026-09-24T00:00:00Z';
  const canned = ONE_BRANCH_KB.canned.map((c) => ({ ...c, reviewedAt: reviewed }));
  return {
    customerAttachments: [],
    customerSentPhoto: false,
    history: [],
    eventAt: new Date('2026-09-25T03:00:00Z'),
    now: new Date('2026-09-25T03:00:10Z'),
    promptStable,
    promptVolatile: 'ОДОО: НЭЭЛТТЭЙ',
    modelId: 'a-model',
    cacheMode: '1h',
    timeoutMs: 25_000,
    rules: [],
    deterministic: [],
    historyState: { known: true, empty: true },
    canned,
    tenantGuard: {
      primaryScript: 'Cyrillic',
      allowedUrls: [
        'https://www.matrixecosalon.org/',
        'https://maps.app.goo.gl/ckEXBLoq4FnxJHq16',
        'https://www.matrixecosalon.org/products.html',
        // The second branch's link, which `reception/load.ts` adds only for a branch prefix.
        // Harmless for the one-location scenarios: no reply there carries it.
        ...(promptStable.includes(ZAISAN.maps) ? [ZAISAN.maps] : []),
      ],
      allowedNumbers: [...allowedNumbers],
      kbHasPromotion: false, approvedPercentages: [],
      concessionStems: [],
      forbiddenStemSeqs: {},
      promptCorpus: '',
      cannedResponses: canned.map((c) => c.body),
      scriptShareExclusions: [],
      maxReplyChars: 1900,
    },
    cannedLabel: SECTION_LABELS.canned,
    cannedHash: null,
    fallbackLine: null,
    complaintRules: [],
    serviceNames: servicesFromPrefix(promptStable, SECTION_LABELS.priceList),
    serviceAliases: [],
    depositRows: sectionRows(promptStable, SECTION_LABELS.deposits),
    faqAnswers: faqAnswersFromPrefix(promptStable, SECTION_LABELS.faqs),
    spellings: [],
    ...extra,
  } as Omit<ReceptionInput, 'customerMessage'>;
}

/** One hash over every scenario's outcome, so "identical to before" is one comparison. */
export function outcomesHash(outcomes: unknown): string {
  return createHash('sha256').update(JSON.stringify(outcomes), 'utf8').digest('hex');
}
