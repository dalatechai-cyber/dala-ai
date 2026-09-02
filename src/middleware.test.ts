import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config, isExcludedFromMiddleware } from './middleware.ts';

// This is a named check, not a comment. Next door, a middleware that redirected
// sessionless requests to a page turned unknown URLs into soft-200s — and a Meta webhook
// POST is the most sessionless request there is.
// Next anchors matcher patterns to the WHOLE pathname. An unanchored RegExp would happily
// match a later substring (`/meta/dala`) and report a false pass, so anchor it here.
const matcher = new RegExp(`^${config.matcher[0] as string}$`);

test('the webhook and worker paths are excluded from middleware', () => {
  for (const path of [
    '/api/webhooks/meta/dala',
    '/api/webhooks/meta/dala-legacy',
    '/api/workers/reception',
  ]) {
    assert.equal(isExcludedFromMiddleware(path), true, `${path} must be excluded`);
    assert.equal(matcher.test(path), false, `${path} must not match the middleware matcher`);
  }
});

test('ordinary paths still run through middleware', () => {
  for (const path of ['/', '/dashboard', '/api/health']) {
    assert.equal(isExcludedFromMiddleware(path), false);
    assert.equal(matcher.test(path), true, `${path} should match the middleware matcher`);
  }
});
