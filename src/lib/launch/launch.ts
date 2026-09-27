/**
 * A service's launch switch (D-154, `0063`): which rows speak for it, in which state.
 *
 * Founder, 2026-09-27: *"When a staff member is ready I flip ITS switch, and the website AND
 * Дали's chat answers change to live together, with no code or copy edits."*
 *
 * ## One record of the states, frozen at publish
 *
 * `services.launch_state` is the switch, but nothing on the reply path reads it. The compile
 * reads it once, and the snapshot carries what it read (`config_snapshots.launch_states`).
 * The knowledge base is compiled against those states, the fixed replies and their pieces
 * are resolved against them per request, the reply cases are judged against them, and the
 * website reads them from the same snapshot. Flipping the column changes nothing until a
 * publish, and a publish changes everything at one pointer move.
 *
 * ## Null is a format marker, and it fails closed
 *
 * A snapshot published before `0063` has no record. Then a conditioned row or piece NEVER
 * holds — it cannot be shown to — while a row without a condition answers exactly as before.
 * Showing a "live" answer for a service nobody can show is live would be the one error the
 * founder ruled out: *"Дали must never claim a staff member works before its switch is on."*
 *
 * ## Templates: `{{slot}}`, filled from pieces
 *
 * A reply that lists several services cannot be a row per combination of switches. Its body
 * carries `{{slot}}` markers and `items` holds the pieces, each with its own condition:
 *
 *  - a line that is nothing but `{{slot}}` becomes the holding pieces, one per line;
 *  - a slot inside other words becomes the holding pieces joined by «, »;
 *  - a line whose slot has no holding piece is dropped whole, so «⏳ Удахгүй: {{soon}}»
 *    disappears once nothing is coming soon, instead of ending in a colon.
 *
 * A row with slots whose pieces ALL fail has nothing to say and does not answer. A piece may
 * carry `words`: the row's matcher may then contain `{"mode":"item_words"}`, which becomes a
 * `has_word` over the words of the pieces that hold — «a reply that names a service still
 * coming soon», without the names of the ones already live.
 *
 * Every string here is the tenant's own reviewed text; this module only chooses among the
 * pieces and joins them. It names no tenant and no service (the test every decision is
 * measured against): the services are rows, and the conditions are ids.
 */
import { nfc } from '../mn/text.ts';

export type LaunchState = 'live' | 'preregistration';

export const LAUNCH_STATES: readonly LaunchState[] = ['live', 'preregistration'];

/** One service as the compile saw it. The snapshot stores a list of these. */
export type LaunchRecord = { serviceId: string; name: string; state: LaunchState };

/** A row's or a piece's condition: this service, in this state. null = always. */
export type LaunchCondition = { serviceId: string; state: LaunchState } | null;

export type LaunchItem = {
  slot: string;
  body: string;
  condition: LaunchCondition;
  /** Whole words that name this piece's subject, for `{"mode":"item_words"}`. */
  words: readonly string[];
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu; // ascii-safe: a uuid
const SLOT_NAME = /^[a-z][a-z0-9_]{0,31}$/u; // ascii-safe: a slot name is an identifier the operator writes, never customer text
const SLOT_TOKEN = /\{\{([^{}]*)\}\}/gu;

function isState(v: unknown): v is LaunchState {
  return v === 'live' || v === 'preregistration';
}

/**
 * The condition two columns carry. `'bad'` for a half-written one (the database refuses it,
 * so this is a fixture or a future column), which the callers treat as never holding.
 */
export function conditionOf(serviceId: unknown, state: unknown): LaunchCondition | 'bad' {
  const noId = serviceId === null || serviceId === undefined;
  const noState = state === null || state === undefined;
  if (noId && noState) return null;
  if (typeof serviceId !== 'string' || !UUID_RE.test(serviceId) || !isState(state)) return 'bad';
  return { serviceId: serviceId.toLowerCase(), state };
}

/** The states as a lookup, or null when the snapshot has no record (a format marker). */
export type LaunchLookup = ReadonlyMap<string, LaunchState> | null;

export function lookupOf(records: readonly LaunchRecord[] | null): LaunchLookup {
  return records === null ? null : new Map(records.map((r) => [r.serviceId.toLowerCase(), r.state]));
}

/**
 * Does a condition hold? No condition always holds. A condition holds only when the record
 * exists AND names this service in this state: an unknown service, or no record at all,
 * never holds.
 */
export function holds(condition: LaunchCondition | 'bad', states: LaunchLookup): boolean {
  if (condition === null) return true;
  if (condition === 'bad' || states === null) return false;
  return states.get(condition.serviceId) === condition.state;
}

/** `config_snapshots.launch_states` → records, or null for a snapshot that has none. */
export function parseLaunchRecords(raw: unknown): LaunchRecord[] | null {
  if (!Array.isArray(raw)) return null;
  const out: LaunchRecord[] = [];
  for (const r of raw) {
    const o = (r ?? {}) as Record<string, unknown>;
    const id = o['service_id'];
    // A malformed entry is dropped, never guessed: its service's conditions then never
    // hold, which is the safe reading of a record that cannot be read.
    if (typeof id !== 'string' || !UUID_RE.test(id) || !isState(o['state'])) continue;
    out.push({ serviceId: id.toLowerCase(), name: typeof o['name'] === 'string' ? o['name'] : '', state: o['state'] });
  }
  return out;
}

/** Records → what the snapshot stores. Ordered by id, so equal states store equal bytes. */
export function launchJson(records: readonly LaunchRecord[]): { service_id: string; name: string; state: LaunchState }[] {
  return [...records]
    .sort((a, b) => (a.serviceId < b.serviceId ? -1 : a.serviceId > b.serviceId ? 1 : 0))
    .map((r) => ({ service_id: r.serviceId.toLowerCase(), name: r.name, state: r.state }));
}

/** Equality of two records, for "is a publish needed". Null only equals null. */
export function sameLaunch(a: readonly LaunchRecord[] | null, b: readonly LaunchRecord[] | null): boolean {
  if (a === null || b === null) return a === b;
  return JSON.stringify(launchJson(a)) === JSON.stringify(launchJson(b));
}

/**
 * `--launch` overrides on top of the rows: `{ "Вира — …": 'live' }` by service NAME, because
 * that is what an operator types. An override naming no service is returned in `unknown` so
 * the caller refuses rather than publishing a switch that flipped nothing.
 */
export function withOverrides(
  records: readonly LaunchRecord[],
  overrides: ReadonlyMap<string, LaunchState>,
): { records: LaunchRecord[]; unknown: string[] } {
  const byName = new Map(records.map((r) => [nfc(r.name), r]));
  const unknown = [...overrides.keys()].filter((n) => !byName.has(nfc(n)));
  return {
    records: records.map((r) => {
      const o = overrides.get(r.name) ?? overrides.get(nfc(r.name));
      return o === undefined ? r : { ...r, state: o };
    }),
    unknown,
  };
}

/** `items` jsonb → pieces, or null when it does not parse (the row then never answers). */
export function parseItems(raw: unknown): LaunchItem[] | null {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const out: LaunchItem[] = [];
  for (const r of raw) {
    if (r === null || typeof r !== 'object' || Array.isArray(r)) return null;
    const o = r as Record<string, unknown>;
    const slot = o['slot'];
    const body = o['body'];
    if (typeof slot !== 'string' || !SLOT_NAME.test(slot)) return null;
    if (typeof body !== 'string' || body.trim() === '' || /[\r\n]/u.test(body) || body.includes('{{')) return null;
    const condition = conditionOf(o['service_id'], o['state']);
    if (condition === 'bad') return null;
    const words = o['words'];
    if (words !== undefined && words !== null
      && (!Array.isArray(words) || words.some((w) => typeof w !== 'string' || w.trim() === ''))) return null;
    out.push({ slot, body: nfc(body.trim()), condition, words: Array.isArray(words) ? (words as string[]).map((w) => nfc(w)) : [] });
  }
  return out;
}

/** The slot names a template uses, in order of first use. */
export function slotsIn(template: string): string[] {
  const seen: string[] = [];
  for (const m of template.matchAll(SLOT_TOKEN)) {
    const name = m[1] ?? '';
    if (!seen.includes(name)) seen.push(name);
  }
  return seen;
}

/**
 * Fill a template's slots with the pieces that hold, or null when it cannot be filled:
 * a slot name no piece declares, a malformed marker, or nothing left to say.
 *
 * A template with no slots is returned as it is (a row without pieces).
 */
export function fillTemplate(template: string, items: readonly LaunchItem[], states: LaunchLookup): string | null {
  const slots = slotsIn(template);
  if (slots.length === 0) return template.includes('{{') || template.includes('}}') ? null : template;
  const declared = new Set(items.map((i) => i.slot));
  if (slots.some((s) => !SLOT_NAME.test(s) || !declared.has(s))) return null;
  const holding = new Map<string, string[]>();
  for (const it of items) {
    if (!holds(it.condition, states)) continue;
    const list = holding.get(it.slot) ?? [];
    list.push(it.body);
    holding.set(it.slot, list);
  }
  const out: string[] = [];
  let filledAny = false;
  for (const line of template.split('\n')) {
    const used = slotsIn(line);
    if (used.length === 0) { out.push(line); continue; }
    // A line with a slot that has nothing in it is dropped whole: it was ABOUT that slot.
    if (used.some((s) => (holding.get(s) ?? []).length === 0)) continue;
    const alone = used.length === 1 && line.trim() === `{{${used[0]}}}`;
    if (alone) {
      out.push(...(holding.get(used[0] ?? '') ?? []));
    } else {
      out.push(line.replace(SLOT_TOKEN, (_m, name: string) => (holding.get(name) ?? []).join(', ')));
    }
    filledAny = true;
  }
  if (!filledAny) return null;
  const text = out.join('\n').replace(/\n{3,}/gu, '\n\n').trim();
  return text === '' ? null : text;
}

/**
 * Replace every `{"mode":"item_words"}` in a raw matcher with a `has_word` over the words of
 * the pieces that hold. Returns null when the matcher uses it and no holding piece has a
 * word: the row would fire on nothing, so it does not fire at all.
 */
export function resolveItemWords(matcher: unknown, items: readonly LaunchItem[], states: LaunchLookup): unknown | null {
  const words = [...new Set(items.filter((i) => holds(i.condition, states)).flatMap((i) => i.words))];
  let empty = false;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== 'object') return node;
    const o = node as Record<string, unknown>;
    if (o['mode'] === 'item_words') {
      if (words.length === 0) empty = true;
      return { mode: 'has_word', words };
    }
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, walk(v)]));
  };
  const out = walk(matcher);
  return empty ? null : out;
}

/** Why a raw fixed-reply row was withheld by its launch condition or pieces. */
export type LaunchWithheld = { intent: string; reason: 'condition' | 'bad_condition' | 'bad_items' | 'empty_slots' | 'no_item_words' };

/**
 * Resolve raw `deterministic_replies` rows against the states: rows whose condition does not
 * hold are withheld; a row's `body`/`web_body` slots are filled; `item_words` is expanded.
 * What comes back is shaped as the rows were, minus the launch columns, so `toDeterministic`
 * reads it unchanged. A withheld row is left out, never sent half-filled.
 */
export function resolveDeterministicRows(
  raw: unknown,
  states: LaunchLookup,
): { rows: Record<string, unknown>[]; withheld: LaunchWithheld[] } {
  const rows: Record<string, unknown>[] = [];
  const withheld: LaunchWithheld[] = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    const o = (r ?? {}) as Record<string, unknown>;
    const intent = String(o['intent'] ?? '');
    const condition = conditionOf(o['when_service_id'], o['when_launch_state']);
    if (condition === 'bad') { withheld.push({ intent, reason: 'bad_condition' }); continue; }
    if (!holds(condition, states)) { withheld.push({ intent, reason: 'condition' }); continue; }
    const items = parseItems(o['items']);
    if (items === null) { withheld.push({ intent, reason: 'bad_items' }); continue; }
    const { when_service_id: _a, when_launch_state: _b, items: _c, ...rest } = o;
    const body = typeof o['body'] === 'string' ? fillTemplate(o['body'], items, states) : null;
    if (body === null) { withheld.push({ intent, reason: slotsIn(String(o['body'] ?? '')).length > 0 ? 'empty_slots' : 'bad_items' }); continue; }
    let webBody: unknown = o['web_body'];
    if (typeof webBody === 'string' && webBody.trim() !== '') {
      const filled = fillTemplate(webBody, items, states);
      if (filled === null) { withheld.push({ intent, reason: 'empty_slots' }); continue; }
      webBody = filled;
    }
    let matcher: unknown = o['matcher'];
    if (matcher !== null && matcher !== undefined) {
      const resolved = resolveItemWords(matcher, items, states);
      if (resolved === null) { withheld.push({ intent, reason: 'no_item_words' }); continue; }
      matcher = resolved;
    }
    rows.push({ ...rest, body, web_body: webBody, matcher });
  }
  return { rows, withheld };
}

/**
 * Every service id a tenant's rows name in a condition or a piece, with where. For the
 * publish check: a reference to a service the tenant does not have is a switch that can
 * never be flipped, and must be fixed before anything goes out. The row-level columns are
 * foreign keys already; the pieces are jsonb, so this is where they are checked.
 */
export function itemReferences(raw: unknown): { intent: string; serviceId: string }[] {
  const out: { intent: string; serviceId: string }[] = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    const o = (r ?? {}) as Record<string, unknown>;
    const items = parseItems(o['items']);
    for (const it of items ?? []) {
      if (it.condition !== null) out.push({ intent: String(o['intent'] ?? ''), serviceId: it.condition.serviceId });
    }
  }
  return out;
}
