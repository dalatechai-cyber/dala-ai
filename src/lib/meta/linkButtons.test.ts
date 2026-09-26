import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buttonTitle, displayAddress, linkButtonMessage } from './linkButtons.ts';

test('DONE-TEST: AN ADDRESS THAT ENDS ITS LINE MOVES ONTO A BUTTON; THE WORDS STAY', () => {
  // The founder's case, 2026-09-26: a preview card under the follow-up line.
  assert.deepEqual(linkButtonMessage('Асуух зүйл байвал бичээрэй.\n👉 Бусад AI ажилтнууд: https://dalatech.online'), {
    text: 'Асуух зүйл байвал бичээрэй.\n👉 Бусад AI ажилтнууд:',
    buttons: [{ url: 'https://dalatech.online', title: 'dalatech.online' }],
  });
  assert.deepEqual(linkButtonMessage('Демо үзэх бол: https://app.dalatech.online.'), {
    text: 'Демо үзэх бол:',
    buttons: [{ url: 'https://app.dalatech.online', title: 'app.dalatech.online' }],
  });
});

test('an address inside a sentence stays readable as its bare host, and is still a button', () => {
  assert.deepEqual(linkButtonMessage('Дэлгэрэнгүй мэдээллийг https://dalatech.online хуудаснаас үзэх боломжтой.'), {
    text: 'Дэлгэрэнгүй мэдээллийг dalatech.online хуудаснаас үзэх боломжтой.',
    buttons: [{ url: 'https://dalatech.online', title: 'dalatech.online' }],
  });
  // A Mongolian case suffix is the sentence's, never the link's.
  const m = linkButtonMessage('Манай https://dalatech.online-д зочлоорой.');
  assert.equal(m?.text, 'Манай dalatech.online-д зочлоорой.');
  assert.equal(m?.buttons[0]?.url, 'https://dalatech.online');
});

test('two addresses are two buttons in the order written; a longer one is never cut by a shorter', () => {
  const m = linkButtonMessage('Сайт: https://dalatech.online\nДемо: https://dalatech.online/demo');
  assert.deepEqual(m?.buttons.map((b) => b.url), ['https://dalatech.online', 'https://dalatech.online/demo']);
  assert.equal(m?.text, 'Сайт:\nДемо:');
});

test('no address, or more than three, is plain text — a link is never dropped to fit', () => {
  assert.equal(linkButtonMessage('Сайн байна уу'), null);
  assert.equal(linkButtonMessage('https://a.mn https://b.mn https://c.mn https://d.mn'), null);
});

test('a reply that is only an address still has text above its button', () => {
  assert.deepEqual(linkButtonMessage('https://www.matrixecosalon.org/'), {
    text: 'matrixecosalon.org',
    buttons: [{ url: 'https://www.matrixecosalon.org/', title: 'matrixecosalon.org' }],
  });
});

test('labels are the address itself, within Meta\'s 20 characters', () => {
  assert.equal(buttonTitle('https://www.example.com/x'), 'example.com');
  assert.equal([...buttonTitle('https://a-very-long-subdomain.example.com')].length, 20);
  assert.equal(displayAddress('www.maps.app.goo.gl/abc'), 'maps.app.goo.gl/abc');
});
