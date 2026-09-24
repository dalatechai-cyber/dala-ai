import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  controlAfter, controlFromEcho, humanHoldsThread, parseHandoverEvents,
  type HandoverEvent, type ThreadState,
} from './control.ts';

const OURS = '1380702870025418';   // dalatech, per CLAUDE.md's console reading
const INBOX = '263902037430900';   // the Page Inbox app — UNVERIFIED, see the module header
const NOW = new Date('2026-09-17T04:00:00Z');
const ev = (o: Partial<HandoverEvent> = {}): HandoverEvent => ({
  kind: 'pass', newOwnerAppId: null, previousOwnerAppId: null, psid: 'psid_1', at: NOW, ...o,
});

// --- parsing ------------------------------------------------------------------------

test('DONE-TEST: A HANDOVER IS READ FROM EITHER CONTAINER', () => {
  // The delivery shape is NOT verified — developers.facebook.com is 403 through this
  // environment's proxy — so both plausible containers are searched. Guessing one and
  // being wrong costs every handover event there will ever be.
  const inMessaging = parseHandoverEvents({
    messaging: [{ sender: { id: 'psid_1' }, timestamp: NOW.getTime(),
                  pass_thread_control: { new_owner_app_id: INBOX } }],
  });
  assert.equal(inMessaging.events.length, 1);
  assert.equal(inMessaging.events[0]?.newOwnerAppId, INBOX);

  const inOwnArray = parseHandoverEvents({
    messaging_handovers: [{ sender: { id: 'psid_1' },
                            take_thread_control: { previous_owner_app_id: OURS } }],
  });
  assert.equal(inOwnArray.events.length, 1);
  assert.equal(inOwnArray.events[0]?.kind, 'take');
});

test('DONE-TEST: AN UNREADABLE HANDOVER IS COUNTED, NEVER FOLDED INTO ZERO', () => {
  // D-057 in the one file whose input shape nobody here could confirm. An entry that
  // carried a handover key and named nobody is the single most informative thing this
  // path can emit — it is what will settle the shape from a real event.
  const r = parseHandoverEvents({ messaging: [{ pass_thread_control: {} }] });
  assert.equal(r.events.length, 0, 'never an event with three nulls');
  assert.equal(r.unrecognised, 1);
});

test('ordinary messages and receipts are not handover events', () => {
  const r = parseHandoverEvents({
    messaging: [
      { sender: { id: 'p' }, message: { mid: 'm_1', text: 'сайн уу' } },
      { sender: { id: 'p' }, delivery: { mids: ['m_1'] } },
    ],
  });
  assert.deepEqual([r.events.length, r.unrecognised], [0, 0]);
});

test('an app id arriving as a number is the same id as the string', () => {
  const r = parseHandoverEvents({
    messaging: [{ sender: { id: 'psid_1' }, pass_thread_control: { new_owner_app_id: 263902037430900 } }],
  });
  assert.equal(r.events[0]?.newOwnerAppId, INBOX);
});

// --- what an event means ------------------------------------------------------------

test('DONE-TEST: WITHOUT OUR META APP ID EVERY VERDICT IS UNKNOWN', () => {
  // `tenant_channels.meta_app_id` is new in 0027 and nullable, because only the console
  // can supply it. D-041 is why it cannot be inferred from `app_slug`: the slug names a
  // callback path on this platform, not an app at Meta. Null changes no state.
  assert.equal(controlAfter(ev({ newOwnerAppId: INBOX }), null), 'unknown');
  assert.equal(controlAfter(ev({ newOwnerAppId: INBOX }), ''), 'unknown');
});

test('DONE-TEST: PASSED TO THE INBOX IS human; PASSED TO US IS bot', () => {
  assert.equal(controlAfter(ev({ newOwnerAppId: INBOX }), OURS), 'human');
  assert.equal(controlAfter(ev({ newOwnerAppId: OURS }), OURS), 'bot');
});

test('a take names who it was taken FROM, and never who now holds it', () => {
  // Taken from us: we have lost it. Taken from anyone else: says nothing about us, so
  // claiming `bot` here would be inventing an owner.
  assert.equal(controlAfter(ev({ kind: 'take', previousOwnerAppId: OURS }), OURS), 'human');
  assert.equal(controlAfter(ev({ kind: 'take', previousOwnerAppId: INBOX }), OURS), 'unknown');
});

test('a request moves nothing — it is somebody asking', () => {
  assert.equal(controlAfter(ev({ kind: 'request', newOwnerAppId: INBOX }), OURS), 'unknown');
});

// --- echoes -------------------------------------------------------------------------

const OUR_APP = '1562862634970492';
const INBOX_APP = '263902037430900';

test('DONE-TEST: AN UNREADABLE ECHO LOOKUP CONCLUDES NOTHING', () => {
  // Concluding `human` would silence a tenant's bot on a database blip; concluding `bot`
  // would let it talk over a receptionist. Neither is supported, so the answer is null —
  // leave the thread exactly as it was. Undetermined is a result (D-057).
  assert.deepEqual(controlFromEcho('unreadable', INBOX_APP, OUR_APP), { control: null, kind: 'unreadable' });
  assert.deepEqual(controlFromEcho(true, OUR_APP, OUR_APP), { control: null, kind: 'ours' },
    'our own send changes nothing');
  assert.deepEqual(controlFromEcho(false, null, OUR_APP), { control: 'human', kind: 'human' },
    'nobody claims it');
});

test('DONE-TEST: A REPLY TYPED IN THE PAGE INBOX IS A PERSON (event 768, live, 2026-09-24)', () => {
  // The real echo: the founder answered a customer by hand from Matrix's Page inbox and Meta
  // stamped it with its own inbox app. The old rule read "an app id" as "not a person", and
  // the bot answered the customer's next message on top of the staff reply.
  assert.deepEqual(controlFromEcho(false, INBOX_APP, OUR_APP), { control: 'human', kind: 'human' });
});

test('DONE-TEST: ONLY OUR OWN APP IS THE BOT — EVERY OTHER SENDER IS A PERSON', () => {
  // Our echo can outrun `markSent`, so the `mid` lookup misses; our app id still says bot.
  assert.deepEqual(controlFromEcho(false, OUR_APP, OUR_APP), { control: null, kind: 'ours' });
  // Any other app, the retired ancestor included, is somebody else answering this customer.
  assert.deepEqual(controlFromEcho(false, '1380702870025418', OUR_APP), { control: 'human', kind: 'human' });
});

test('without our own app id, an app-stamped echo is not judged — it could be our own reply', () => {
  assert.deepEqual(controlFromEcho(false, OUR_APP, null), { control: null, kind: 'app' });
  assert.deepEqual(controlFromEcho(false, null, null), { control: 'human', kind: 'human' });
});

// --- H11 check 4 --------------------------------------------------------------------

const state = (o: Partial<ThreadState> = {}): ThreadState => ({ control: 'human', at: NOW, ...o });

test('DONE-TEST: unknown NEVER SILENCES A TENANT', () => {
  // Every conversation predating 0027 reads `unknown`. The migration chose the honest
  // default over the convenient one (D-063's addendum), and that is only safe because
  // this gate refuses on a positively-established `human` and nothing else. The pairing
  // is one design; breaking either half mutes every tenant at once.
  assert.equal(humanHoldsThread(state({ control: 'unknown', at: null }), 30, NOW).refuse, false);
  assert.equal(humanHoldsThread(state({ control: 'bot' }), 30, NOW).refuse, false);
});

test('DONE-TEST: THE COOLDOWN RUNS FROM THE HANDOVER, NOT THE LAST MESSAGE', () => {
  const tookAt = new Date('2026-09-17T03:45:00Z'); // 15 minutes before NOW
  const held = humanHoldsThread(state({ at: tookAt }), 30, NOW);
  assert.equal(held.refuse, true);
  assert.equal(held.reason, 'human_has_thread');
  assert.equal(held.minutesLeft, 15);

  // 31 minutes on, the bot resumes drafting on its own.
  const later = new Date('2026-09-17T04:16:00Z');
  assert.equal(humanHoldsThread(state({ at: tookAt }), 30, later).refuse, false);
});

test('human with no timestamp is treated as current', () => {
  // A real state: an echo seen before `thread_control_at` was ever written. The
  // alternative is talking over a person on the strength of a missing timestamp.
  assert.equal(humanHoldsThread(state({ at: null }), 30, NOW).refuse, true);
});

test('a zero cooldown resumes immediately and still RECORDS the handover', () => {
  // A tenant saying "never stay quiet". The recording is the half that matters for
  // measuring how often a receptionist actually picks a thread up.
  assert.equal(humanHoldsThread(state(), 0, NOW).refuse, false);
});
