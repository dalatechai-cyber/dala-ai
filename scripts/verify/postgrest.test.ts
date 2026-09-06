import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exposedFrom, namesFromSource } from './postgrest.ts';

test('the names come from the source, never from a list', () => {
  // A transcribed list would pass while the code called something else — the exact shape
  // of the failure this check exists to prevent, one level up.
  const { rpcs, tables } = namesFromSource();
  assert.ok(rpcs.includes('reserve_spend_all'), `rpcs: ${rpcs.join(', ')}`);
  assert.ok(rpcs.includes('release_spend'));
  assert.ok(rpcs.includes('settle_spend_all'));
  assert.ok(tables.includes('outbound_messages') && tables.includes('config_snapshots'));
  // Nothing invented: every name is a plain identifier, so a stray match would show up.
  for (const name of [...rpcs, ...tables]) assert.match(name, /^[a-z][a-z0-9_]*$/); // ascii-safe: SQL identifiers
});

test('DONE-TEST: EXPOSURE IS ENUMERATED, not inferred from an error code', () => {
  // The first version of this check called each RPC with `{}` and read `PGRST202` as "not
  // found". It reported everything healthy INCLUDING A FUNCTION THAT HAD JUST BEEN
  // DROPPED, because PostgREST resolves overloads by argument name and returns PGRST202
  // for an existing function called with the wrong ones. A check whose pass condition is
  // "no specific error came back" is green when it is broken.
  const doc = {
    paths: {
      '/': {},
      '/rpc/reserve_spend_all': {},
      '/rpc/release_spend': {},
      '/tenants': {},
      '/outbound_messages': {},
    },
  };
  const { rpcs, tables } = exposedFrom(doc);
  assert.deepEqual([...rpcs].sort(), ['release_spend', 'reserve_spend_all']);
  assert.deepEqual([...tables].sort(), ['outbound_messages', 'tenants']);
});

test('an empty or malformed document exposes nothing, rather than throwing', () => {
  // A PostgREST that answered with something unexpected must fail the check, not crash it
  // — the difference between "the transport is broken" and "the script is broken" should
  // not be a stack trace.
  assert.equal(exposedFrom({}).rpcs.size, 0);
  assert.equal(exposedFrom(null).tables.size, 0);
  assert.equal(exposedFrom('nonsense').tables.size, 0);
});
