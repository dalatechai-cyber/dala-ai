// Asserts the synthetic fixture in gate.test.mjs still reflects the real prefix.
//
// Skips when the ancestor checkout is absent — Matrix-Chatbot is private, so CI
// cannot clone it. A skip is reported as a skip, never as a pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildMatrixPrefix, DEFAULT_ANCESTOR } from '../prefix.mjs';

const ancestor = process.env.ANCESTOR || DEFAULT_ANCESTOR;
const available = fs.existsSync(ancestor);

test('the figures the gate tests rely on are really in the ancestor prefix',
  { skip: available ? false : `ancestor not checked out at ${ancestor}` },
  async () => {
    const prefix = await buildMatrixPrefix(ancestor);
    // If any of these stops being true, the synthetic fixture has drifted from
    // production and the gate tests are reasoning about a prefix that no longer
    // exists.
    for (const s of ['20,000', '30,000', '25,000'])
      assert.ok(prefix.includes(s), `real prefix no longer contains ${s}`);

    // The salon's phone is read from the ancestor's OWN config rather than
    // transcribed here. It used to be the literal '+976 7741 7777', and on
    // 2026-09-19 the salon replaced that number — so this assertion went red in a
    // repo whose diff did not touch it, in the one test CI always skips because
    // Matrix-Chatbot is private and cannot be cloned there.
    //
    // A transcribed constant makes this test a second copy of a fact that lives
    // somewhere else, which is exactly what prefix.mjs's own header refuses to do
    // with the price list. Comparing production against itself cannot drift, and
    // still fails loudly if the phone stops reaching the prefix at all.
    const { clientData } = await import(
      pathToFileURL(path.join(ancestor, 'config', 'currentClient.js')).href);
    const phone = clientData?.knowledge?.contact?.phone;
    assert.ok(typeof phone === 'string' && phone !== '',
      'the ancestor declares no contact phone — this check must fail loudly, never vacuously');
    assert.ok(prefix.includes(phone), `real prefix no longer contains the declared phone ${phone}`);
  });
