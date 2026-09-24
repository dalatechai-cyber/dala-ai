/**
 * Who holds this Messenger thread, and may the bot speak?
 *
 * Two facts arrive by different routes and mean different things, so they are parsed
 * separately and merged deliberately:
 *
 *  - **A handover event.** Meta saying outright that thread control moved. Authoritative.
 *  - **An echo.** An outbound message on a thread whose `mid` is not one of ours. It is an
 *    INFERENCE, and it is the only detector that works at all while another app owns the
 *    thread — a handover we were never told about produces no event and no error, only a
 *    receptionist and a bot answering the same customer in parallel.
 *
 * ## `is_echo` used to be thrown away, which is why this could not be built before
 *
 * `meta/extract.ts` skipped an echo with `skip('echo')` and carried NO identifiers, so the
 * one question worth asking — *did WE send this?* — had nothing to ask it with. The skip
 * now carries the `mid`, which is the whole unlock.
 *
 * ## What this file does NOT do
 *
 * It sends nothing and calls no Graph endpoint. `pass_thread_control` and
 * `take_thread_control` are the outbound half and are deliberately absent: passing control
 * is a live mutation of a real salon's thread ownership, it cannot be rehearsed during a
 * shadow mirror, and the receiver configuration on the Page is not yet known. This half is
 * observational — it learns who holds threads so the decision to build the other half can
 * be made against measured numbers rather than ahead of them.
 *
 * ## The delivery shape is NOT verified, and this file is built to say so
 *
 * `developers.facebook.com` is refused by this environment's egress proxy (403 through the
 * CONNECT tunnel, measured 2026-09-17), so no session can read Meta's current docs. The
 * parser therefore looks in both plausible places and, crucially, **counts what it could
 * not classify** instead of returning only what it managed — D-057's rule, in the one file
 * whose input shape nobody here has been able to confirm. The first real handover event on
 * a live Page is what settles it, and `unrecognised` is how it will be visible.
 */

/** Operationally: does THIS platform hold the thread? `human` means someone else does. */
export type ThreadControl = 'bot' | 'human' | 'unknown';

export type HandoverKind = 'pass' | 'take' | 'request';

export type HandoverEvent = {
  kind: HandoverKind;
  /** The app the thread moved TO, where Meta named one. */
  newOwnerAppId: string | null;
  /** The app it moved FROM, where Meta named one. */
  previousOwnerAppId: string | null;
  /** The customer whose thread this is (Meta's PSID), where present. */
  psid: string | null;
  at: Date | null;
};

export type HandoverParse = {
  events: HandoverEvent[];
  /**
   * Entries that looked like a handover and could not be read. NEVER folded into zero:
   * an unreadable count and an absence are different facts, and this whole module rests
   * on a shape nobody here has been able to verify.
   */
  unrecognised: number;
};

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asRecord = (v: unknown): Record<string, unknown> =>
  (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => {
  if (typeof v === 'string' && v.trim() !== '') return v;
  // Meta has returned app ids as numbers as well as strings. Both are the same id.
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : null;
};

const KEYS: Record<string, HandoverKind> = {
  pass_thread_control: 'pass',
  take_thread_control: 'take',
  request_thread_control: 'request',
};

/**
 * Read every handover event in one webhook entry.
 *
 * Both containers are searched. `entry.messaging[]` is where I believe these arrive — the
 * same array as ordinary messages, with a `pass_thread_control` key in place of `message`
 * — and `entry.messaging_handovers[]` is checked too because the subscribed FIELD is named
 * that, and an array of that name is the other obvious shape. Searching a container that
 * never exists costs one `Array.isArray` and removes a whole class of silent miss; guessing
 * which one is right, and being wrong, costs every handover event there will ever be.
 */
export function parseHandoverEvents(entry: unknown): HandoverParse {
  const e = asRecord(entry);
  const events: HandoverEvent[] = [];
  let unrecognised = 0;

  for (const container of ['messaging', 'messaging_handovers'] as const) {
    for (const raw of asArray(e[container])) {
      const ev = asRecord(raw);
      const key = Object.keys(KEYS).find((k) => k in ev);
      if (key === undefined) continue; // an ordinary message or a receipt — not ours to read

      const body = asRecord(ev[key]);
      const kind = KEYS[key] as HandoverKind;
      const psid = str(asRecord(ev['sender'])['id']) ?? str(asRecord(ev['recipient'])['id']);
      const ts = ev['timestamp'];
      const at = typeof ts === 'number' && Number.isFinite(ts) ? new Date(ts) : null;
      const newOwner = str(body['new_owner_app_id']);
      const previousOwner = str(body['previous_owner_app_id']);

      // It carried the key and named nobody and no customer. Recorded as unreadable rather
      // than as an event with three nulls, which would read downstream as a real handover
      // to an unknown app and move a tenant's thread state on no evidence at all.
      if (newOwner === null && previousOwner === null && psid === null) { unrecognised += 1; continue; }

      events.push({ kind, newOwnerAppId: newOwner, previousOwnerAppId: previousOwner, psid, at });
    }
  }
  return { events, unrecognised };
}

/**
 * What a handover event means for who holds the thread.
 *
 * `ourAppId` is this platform's Meta app id for the channel — a row, never a literal, and
 * never inferred from the callback slug: D-041 is the whole lesson that
 * `tenant_channels.app_slug` is this platform's name for a callback path and not Meta's
 * name for an app.
 *
 * A `request` moves nothing. It is somebody asking; the answer is a later `pass`.
 */
export function controlAfter(event: HandoverEvent, ourAppId: string | null): ThreadControl {
  if (event.kind === 'request') return 'unknown';
  if (ourAppId === null || ourAppId === '') return 'unknown';

  // A `take` names who it was taken FROM, never who now holds it. Taken from us means we
  // have lost it; taken from anyone else says nothing about whether we have it.
  if (event.kind === 'take') {
    return event.previousOwnerAppId === ourAppId ? 'human' : 'unknown';
  }
  if (event.newOwnerAppId === null) return 'unknown';
  return event.newOwnerAppId === ourAppId ? 'bot' : 'human';
}

/**
 * Does this echo mean a person answered?
 *
 * `ours` answers "is this `mid` one of our own sends?", and it is deliberately a TRISTATE.
 * A lookup that FAILED is not a lookup that returned false: concluding `human` from an
 * unreadable table would silence a tenant's bot on a database blip, and concluding `bot`
 * would let it talk over a receptionist. Neither is supported by the evidence, so an
 * unreadable lookup changes nothing and says so — undetermined is a result (D-057), and
 * here the result is "leave the thread exactly as it was".
 *
 * Returns null for "no change", never a default.
 */
export type EchoKind =
  /** The `mid` is one of our own sends. Positive, and the strongest answer available. */
  | 'ours'
  /** The lookup failed. Undetermined is a result (D-057); nothing moves. */
  | 'unreadable'
  /** An app sent it and we do not know our own app id, so it cannot be judged. Nothing moves. */
  | 'app'
  /** Not our send and not our app: the Page inbox, another app, or no app at all. A person. */
  | 'human';

export type EchoVerdict = { control: ThreadControl | null; kind: EchoKind };

export function controlFromEcho(
  ours: boolean | 'unreadable',
  appId: string | null,
  ourAppId: string | null,
): EchoVerdict {
  if (ours === 'unreadable') return { control: null, kind: 'unreadable' };
  if (ours) return { control: null, kind: 'ours' };

  // Our own app, before its send was recorded. The echo can outrun `markSent`, and Meta
  // stamps every send through our token with our app id — measured on Matrix's first live
  // hour, every Dala AI reply came back as `1562862634970492`. So the id alone is the bot.
  if (appId !== null && ourAppId !== null && appId === ourAppId) return { control: null, kind: 'ours' };

  // Without our own id we cannot tell our unrecorded send from anyone else's, and guessing
  // `human` would mute a tenant on its own replies. Nothing moves; `kind` keeps it visible.
  if (appId !== null && ourAppId === null) return { control: null, kind: 'app' };

  // EVERYONE ELSE IS A PERSON (founder, 2026-09-24, measured on the live Page). A reply
  // typed in the Page inbox arrives stamped with Meta's own inbox app, `263902037430900`,
  // not with no app at all. The previous rule read any app id as "an app, not a person",
  // so the salon's own staff answered event 768 and the bot answered the customer's next
  // message on top of them (769 → 770). The rule it replaces was written while the
  // ancestor bot was answering the same Page through a second app; that bot is
  // unsubscribed, and a reply from any sender that is not Dala AI is somebody else
  // speaking to this customer, which is exactly when the bot must stay quiet.
  return { control: 'human', kind: 'human' };
}

export type ThreadState = {
  control: ThreadControl;
  /** When control last changed hands. Null when it never has. */
  at: Date | null;
};

/**
 * H11 check 4: may the bot answer this conversation?
 *
 * Refuses on a positively-established `human` and nothing else. `unknown` is the default
 * for every conversation predating `0027` and for every thread whose far side has never
 * been read, and it must never silence anybody — the honest default is only safe because
 * this gate is exactly this narrow. That pairing is the design, not a coincidence; see the
 * migration's own note on D-063's addendum.
 *
 * The cooldown runs from when control CHANGED, never from the last customer message. A
 * customer writing again is not the receptionist letting go — it is usually the opposite,
 * and measuring from `last_message_at` would hand the thread back precisely when the
 * conversation is busiest.
 */
export function humanHoldsThread(
  state: ThreadState,
  cooldownMinutes: number,
  now: Date,
): { refuse: boolean; reason: 'human_has_thread' | null; minutesLeft: number } {
  if (state.control !== 'human') return { refuse: false, reason: null, minutesLeft: 0 };
  // A cooldown of 0 is a tenant saying "resume immediately". The handover is still
  // RECORDED, which is the half that matters for measuring how often this happens.
  if (cooldownMinutes <= 0) return { refuse: false, reason: null, minutesLeft: 0 };
  // Control is `human` and we do not know since when — a real state, produced by an echo
  // seen before `thread_control_at` was ever written. The safe reading is that it is
  // current, because the alternative is talking over a person on the strength of a
  // missing timestamp.
  if (state.at === null) return { refuse: true, reason: 'human_has_thread', minutesLeft: cooldownMinutes };

  const elapsed = (now.getTime() - state.at.getTime()) / 60_000;
  const left = cooldownMinutes - elapsed;
  return left > 0
    ? { refuse: true, reason: 'human_has_thread', minutesLeft: Math.ceil(left) }
    : { refuse: false, reason: null, minutesLeft: 0 };
}
