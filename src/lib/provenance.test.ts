import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTenantConfirmed, readProvenance, unconfirmedNames, PROVENANCE_VALUES } from './provenance.ts';

test('the three values read back as themselves', () => {
  for (const v of PROVENANCE_VALUES) assert.equal(readProvenance(v), v);
});

test('DONE-TEST: everything a reader cannot recognise is NOT confirmed', () => {
  // D-020's own sentence: "a consumer that cannot tell must refuse rather than assume."
  // The absent cases are the real ones — a database that predates 0011, a select that
  // forgot the column, a value from a migration this build has not seen. Each of them
  // reaches a reader as `undefined` or a string it does not know, and the plausible
  // reading ("nothing said it was seeded, so it is probably fine") is precisely the
  // `role_table_grants` bug: empty rather than refusing.
  for (const junk of [undefined, null, '', 'TENANT_CONFIRMED', 'tenant_confirmed ', 'confirmed', 'trusted', 0, 1, true, {}, ['tenant_confirmed']]) {
    assert.equal(readProvenance(junk), null, `${JSON.stringify(junk)} is not a provenance`);
    assert.equal(isTenantConfirmed(junk), false, `${JSON.stringify(junk)} must not be confirmed`);
  }
});

test('seeded and inferred are recognised values, and neither is confirmation', () => {
  assert.equal(readProvenance('seeded'), 'seeded');
  assert.equal(readProvenance('inferred'), 'inferred');
  assert.equal(isTenantConfirmed('seeded'), false);
  assert.equal(isTenantConfirmed('inferred'), false);
  assert.equal(isTenantConfirmed('tenant_confirmed'), true);
});

test('the vocabulary matches the CHECK constraint in 0011, in order', () => {
  // If these drift, the database refuses a value the code writes, or the code trusts one
  // the database allows. Both are silent until an insert fails in production.
  assert.deepEqual([...PROVENANCE_VALUES], ['tenant_confirmed', 'seeded', 'inferred']);
});

test('reported names are de-duplicated, sorted and free of blanks', () => {
  // This text lands in a quality_flags row. Two identical events must produce identical
  // detail, or a duplicate looks like a new finding.
  assert.deepEqual(unconfirmedNames(['b', 'a', 'b', '']), ['a', 'b']);
  assert.deepEqual(unconfirmedNames([]), []);
});
