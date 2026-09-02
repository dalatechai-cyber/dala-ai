import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRawBody, MAX_BODY_BYTES } from './rawBody.ts';

test('a normal body is returned as exact bytes', async () => {
  const body = JSON.stringify({ text: 'Сайн байна уу' });
  const res = await readRawBody(new Request('https://x/', { method: 'POST', body }));
  assert.equal(res.ok, true);
  assert.equal(res.ok && res.bytes.toString('utf8'), body);
});

test('an oversized body is refused with 413, by declared length', async () => {
  const req = new Request('https://x/', {
    method: 'POST', body: 'x', headers: { 'content-length': String(MAX_BODY_BYTES + 1) },
  });
  const res = await readRawBody(req);
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.status, 413);
});

test('Content-Length is a claim, not a fact — actual bytes are checked too', async () => {
  // A lying (or absent) Content-Length must not get past the cap.
  const big = 'a'.repeat(MAX_BODY_BYTES + 10);
  const res = await readRawBody(new Request('https://x/', { method: 'POST', body: big }));
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.status, 413);
});
