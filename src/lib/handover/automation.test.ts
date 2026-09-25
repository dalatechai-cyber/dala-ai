import { test } from 'node:test';
import assert from 'node:assert/strict';
import { automationKey, isAutomationText } from './automation.ts';
import { controlFromEcho } from './control.ts';
import { personEchoesIn } from './presend.ts';

// Measured on DalaTech's Page, 2026-09-26 (webhook events 825 and 827): Meta Business Suite's
// comment automations sent the DM «sn bnuu» with app id 263902037430900 — the id a staff reply
// typed in the Page inbox carries — and the public reply «chat bicnuu».
const INBOX_APP = '263902037430900';
const OUR_APP = '1562862634970492';
const AUTOMATIONS = ['sn bnuu', 'chat bicnuu'];

test('the text is matched after NFC, whitespace and case, and nothing looser', () => {
  assert.equal(automationKey('  Sn   BNUU '), 'sn bnuu');
  assert.equal(isAutomationText('Sn bnuu', AUTOMATIONS), true);
  assert.equal(isAutomationText('sn bnuu?', AUTOMATIONS), false, 'a different text is a person');
  assert.equal(isAutomationText('Болноо', AUTOMATIONS), false);
  assert.equal(isAutomationText('sn bnuu', []), false, 'no rows, no automations — today\'s behaviour');
  assert.equal(isAutomationText(null, AUTOMATIONS), false);
});

test('DONE-TEST (live, 2026-09-26): AN AUTOMATED DM WITH THE INBOX APP ID IS NOT A PERSON', () => {
  assert.deepEqual(controlFromEcho(false, INBOX_APP, OUR_APP, true), { control: null, kind: 'automation' });
  // The same echo from a person typing in the inbox is still a person.
  assert.deepEqual(controlFromEcho(false, INBOX_APP, OUR_APP, false), { control: 'human', kind: 'human' });
});

test('the pre-send check does not drop a reply because an automation spoke', () => {
  const entry = (text: string) => ({
    id: '863503883522801',
    messaging: [{
      sender: { id: '863503883522801' }, recipient: { id: 'psid-1' },
      message: { mid: 'm_1', text, app_id: Number(INBOX_APP), is_echo: true },
    }],
  });
  assert.equal(personEchoesIn(entry('sn bnuu'), 'psid-1', OUR_APP, AUTOMATIONS), 0);
  assert.equal(personEchoesIn(entry('Сайн байна уу, би ажилтан байна'), 'psid-1', OUR_APP, AUTOMATIONS), 1);
});
