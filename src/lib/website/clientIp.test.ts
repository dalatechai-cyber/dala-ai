import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientIpOf, UNKNOWN_CLIENT_IP } from './clientIp.ts';

const h = (init: Record<string, string>) => new Headers(init);

test('x-real-ip wins, because it is not a list and cannot be mis-indexed', () => {
  assert.equal(clientIpOf(h({ 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1' })), '203.0.113.7');
});

test('DONE-TEST: the RIGHTMOST forwarded entry is taken, never the first', () => {
  // This is the whole reason the module exists. A client may send its own X-Forwarded-For
  // and each proxy APPENDS, so the leftmost entry is attacker-controlled and the rightmost
  // is what the nearest proxy observed.
  //
  // Taking [0] is the reflex, and it hands an attacker the rate-limit bucket key: vary the
  // first entry per request and every request opens a fresh window, so the limiter counts
  // to one for ever while looking like it works.
  const spoofed = h({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 203.0.113.7' });
  assert.equal(clientIpOf(spoofed), '203.0.113.7');
  assert.notEqual(clientIpOf(spoofed), '1.1.1.1', 'the attacker-controlled entry must never win');
});

test('a single forwarded entry is both ends of the list', () => {
  assert.equal(clientIpOf(h({ 'x-forwarded-for': '203.0.113.7' })), '203.0.113.7');
});

test('whitespace and empty entries do not shift which entry is last', () => {
  assert.equal(clientIpOf(h({ 'x-forwarded-for': ' 1.1.1.1 ,  , 203.0.113.7 ,  ' })), '203.0.113.7');
});

test('DONE-TEST: an unreadable address is a NAMED bucket, never an empty string', () => {
  // '' would put every unidentifiable caller into one nameless bucket alongside anything
  // else that ever produced '', which is impossible to reason about and invisible in a
  // log. A stable, nameable key bounds them together and says what it is.
  assert.equal(clientIpOf(h({})), UNKNOWN_CLIENT_IP);
  assert.equal(clientIpOf(h({ 'x-forwarded-for': '' })), UNKNOWN_CLIENT_IP);
  assert.equal(clientIpOf(h({ 'x-forwarded-for': '  ,  ' })), UNKNOWN_CLIENT_IP);
  assert.equal(clientIpOf(h({ 'x-real-ip': '   ' })), UNKNOWN_CLIENT_IP);
  assert.notEqual(UNKNOWN_CLIENT_IP, '');
});

test('an empty x-real-ip falls through to the forwarded list rather than giving up', () => {
  assert.equal(clientIpOf(h({ 'x-real-ip': '', 'x-forwarded-for': '1.1.1.1, 203.0.113.7' })), '203.0.113.7');
});

test('IPv6 survives intact — it is a string, not something to parse', () => {
  assert.equal(clientIpOf(h({ 'x-real-ip': '2001:db8::1' })), '2001:db8::1');
});
