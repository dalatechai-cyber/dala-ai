// Asserts the synthetic fixture in gate.test.mjs still reflects the real prefix.
//
// Skips when the ancestor checkout is absent — Matrix-Chatbot is private, so CI
// cannot clone it. A skip is reported as a skip, never as a pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
    for (const s of ['20,000', '30,000', '25,000', '+976 7741 7777'])
      assert.ok(prefix.includes(s), `real prefix no longer contains ${s}`);
  });
