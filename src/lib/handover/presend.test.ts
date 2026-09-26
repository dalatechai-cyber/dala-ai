import { test } from 'node:test';
import assert from 'node:assert/strict';
import { personEchoesIn, personRepliedSince } from './presend.ts';

const PSID = '28319159404400214';
const OUR_APP = '1562862634970492';
const INBOX_APP = 263902037430900;   // Meta's Page inbox: a person typing

const entry = (recipient: string, appId: number | null, isEcho = true) => ({
  id: '1520409424715591',
  messaging: [{
    sender: { id: '1520409424715591' }, recipient: { id: recipient },
    message: { mid: 'm_x', text: 'Болноо', is_echo: isEcho, ...(appId === null ? {} : { app_id: appId }) },
  }],
});

test('a staff reply from the Page inbox to THIS customer is a person', () => {
  assert.equal(personEchoesIn(entry(PSID, INBOX_APP), PSID, OUR_APP), 1);
});

test('our own send, a reply to another customer, and a customer message are not', () => {
  assert.equal(personEchoesIn(entry(PSID, Number(OUR_APP)), PSID, OUR_APP), 0);
  // 2026-09-25 14:16:57: «Манай салбар ажилна» went to a DIFFERENT customer than the one
  // being answered at that moment. It must not stop that reply.
  assert.equal(personEchoesIn(entry('38717672411212186', INBOX_APP), PSID, OUR_APP), 0);
  assert.equal(personEchoesIn(entry(PSID, null, false), PSID, OUR_APP), 0);
  assert.equal(personEchoesIn(null, PSID, OUR_APP), 0);
});

/** A two-table stub: `conversations` for the thread state, `webhook_events` for the scan. */
function db(conv: { data?: unknown; error?: unknown }, events: { data?: unknown; error?: unknown }) {
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'gt', 'contains', 'order', 'limit']) chain[m] = () => chain;
    const reply = table === 'conversations' ? conv : events;
    chain['maybeSingle'] = async () => ({ data: null, error: null, ...reply });
    chain['then'] = (res: (v: unknown) => unknown) => res({ data: null, error: null, ...reply });
    return chain;
  };
  return { from } as never;
}

const INPUT = {
  tenantId: 't', channelId: 'c', conversationId: 'conv', psid: PSID, eventId: 794,
  since: new Date('2026-09-25T14:16:41Z'), ourAppId: OUR_APP,
};

test('the thread marked human at or after the message is a reply', async () => {
  const r = await personRepliedSince(
    db({ data: { thread_control: 'human', thread_control_at: '2026-09-25T14:16:58Z' } }, { data: [] }), INPUT,
  );
  assert.equal(r.replied, true);
});

test('a human hold from BEFORE the message is not a new reply (check 4 already judged it)', async () => {
  const r = await personRepliedSince(
    db({ data: { thread_control: 'human', thread_control_at: '2026-09-25T13:00:00Z' } }, { data: [] }), INPUT,
  );
  assert.deepEqual(r, { replied: false });
});

test('an echo stored after the message counts before its own job has run', async () => {
  const r = await personRepliedSince(
    db({ data: { thread_control: 'unknown', thread_control_at: null } }, { data: [{ id: 798, raw_payload: entry(PSID, INBOX_APP) }] }),
    INPUT,
  );
  assert.equal(r.replied, true);
  assert.equal(r.replied === true && r.via, 'echo');
});

test('either read failing is unreadable, never "no reply"', async () => {
  const a = await personRepliedSince(db({ error: { message: 'reset' } }, { data: [] }), INPUT);
  assert.equal(a.replied, 'unreadable');
  const b = await personRepliedSince(db({ data: { thread_control: 'unknown' } }, { error: { message: 'reset' } }), INPUT);
  assert.equal(b.replied, 'unreadable');
});

// ---------------------------------------------------------------------------
// Instagram (D-141): an echo with NO app id is checked against what we sent
// ---------------------------------------------------------------------------

/** Three tables: the thread, the echo scan, and our recent sends for the text check. */
function dbWithSends(events: unknown[], sends: { data?: unknown; error?: unknown }) {
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'gt', 'gte', 'in', 'contains', 'order', 'limit']) chain[m] = () => chain;
    const reply = table === 'conversations'
      ? { data: { thread_control: 'unknown', thread_control_at: null } }
      : table === 'webhook_events' ? { data: events }
        : table === 'outbound_messages' ? sends : { data: null };
    // `echoIsOurs` reads by mid with maybeSingle: never a match here, so the text decides.
    chain['maybeSingle'] = async () => ({ data: null, error: null, ...(table === 'conversations' ? reply : {}) });
    chain['then'] = (res: (v: unknown) => unknown) => res({ data: null, error: null, ...reply });
    return chain;
  };
  return { from } as never;
}

const IG_REPLY = 'Дали бол AI хүлээн авагч. Таны асуултад 24/7 хариулна.';

test('an app-id-less echo that IS our earlier reply to this customer does not stop the next reply', async () => {
  const r = await personRepliedSince(
    dbWithSends([{ id: 900, raw_payload: { messaging: [{ recipient: { id: PSID }, message: { mid: 'ig_1', text: IG_REPLY, is_echo: true } }] } }],
      { data: [{ body: IG_REPLY }] }),
    INPUT,
  );
  assert.deepEqual(r, { replied: false });
});

test('the second half of a reply Instagram made us split is ours too', async () => {
  const tail = 'Таны асуултад 24/7 хариулна.';
  const r = await personRepliedSince(
    dbWithSends([{ id: 900, raw_payload: { messaging: [{ recipient: { id: PSID }, message: { mid: 'ig_2', text: tail, is_echo: true } }] } }],
      { data: [{ body: IG_REPLY }] }),
    INPUT,
  );
  assert.deepEqual(r, { replied: false });
});

test('a person typing on Instagram is still a person — including a short word inside our reply', async () => {
  for (const text of ['Сайн байна уу, би өөрөө хариулъя', 'Дали']) {
    const r = await personRepliedSince(
      dbWithSends([{ id: 901, raw_payload: { messaging: [{ recipient: { id: PSID }, message: { mid: 'ig_3', text, is_echo: true } }] } }],
        { data: [{ body: IG_REPLY }] }),
      INPUT,
    );
    assert.equal(r.replied, true, text);
  }
});

test('an unreadable send table never unmutes: the echo counts as a person', async () => {
  const r = await personRepliedSince(
    dbWithSends([{ id: 902, raw_payload: { messaging: [{ recipient: { id: PSID }, message: { mid: 'ig_4', text: IG_REPLY, is_echo: true } }] } }],
      { error: { message: 'reset' } }),
    INPUT,
  );
  assert.equal(r.replied, true);
});

test('D-143: our earlier reply with buttons is not "a person replied", with no app id', async () => {
  const r = await personRepliedSince(
    dbWithSends([{ id: 903, raw_payload: { messaging: [{ recipient: { id: PSID }, message: {
      mid: 'ig_t', is_echo: true, attachments: [{ type: 'template', payload: { template_type: 'button', text: 'Демо:' } }],
    } }] } }], { data: [] }),
    INPUT,
  );
  assert.deepEqual(r, { replied: false });
});
