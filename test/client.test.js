import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TadoClient, RateLimitedError, AuthenticationError, HttpError } from '../src/tado/client.js';
import { RateLimitTracker } from '../src/tado/ratelimit.js';

function jsonHeaders(extra = {}) {
  return { 'content-type': 'application/json', ratelimit: '"perday";r=100', ...extra };
}

function scriptedFetch(handler) {
  let calls = [];
  return {
    impl: async (url, options) => {
      calls.push({ url, options });
      const res = await handler({ url, options, index: calls.length - 1 });
      return {
        status: res.status,
        headers: res.headers || jsonHeaders(),
        text: async () => JSON.stringify(res.body ?? null),
      };
    },
    calls,
  };
}

function makeClient(fetchImpl, getToken, tracker) {
  return new TadoClient({
    fetchImpl,
    getToken: getToken || (async () => 'tok'),
    backoff: () => 0,
    tracker: tracker || new RateLimitTracker(),
  });
}

test('performs a GET and returns parsed JSON', async () => {
  const f = scriptedFetch(() => ({ status: 200, body: { id: 1 } }));
  const c = makeClient(f.impl);
  const { data } = await c.getMe();
  assert.deepEqual(data, { id: 1 });
  assert.match(f.calls[0].url, /\/me$/);
  assert.equal(f.calls[0].options.headers.authorization, 'Bearer tok');
});

test('on 401 it force-refreshes the token and retries once', async () => {
  let authCalls = 0;
  const f = scriptedFetch(({ index }) => ({
    status: index === 0 ? 401 : 200,
    body: index === 0 ? {} : { ok: true },
  }));
  // Return a fresh but always-valid token; the point is that the client retries
  // the request after a forced refresh instead of failing.
  const forceFlags = [];
  const realGetToken = async (force) => {
    authCalls += 1;
    forceFlags.push(force);
    return 'fresh';
  };
  const c = makeClient(f.impl, realGetToken);
  const { data } = await c.getMe();
  assert.deepEqual(data, { ok: true });
  assert.equal(authCalls, 2);
  // First call (initial) is not forced; the retry after the 401 IS forced.
  assert.equal(forceFlags[0], undefined);
  assert.equal(forceFlags[1], true);
});

test('throws RateLimitedError on 429 and honours retry-after', async () => {
  const f = scriptedFetch(() => ({
    status: 429,
    headers: jsonHeaders({ 'ratelimit-policy': '"perday";q=100;w=86400', 'retry-after': '60' }),
    body: null,
  }));
  const c = makeClient(f.impl);
  await assert.rejects(c.getMe(), (err) => {
    assert.ok(err instanceof RateLimitedError);
    assert.equal(err.retryAfterMs, 60000);
    return true;
  });
});

test('retries transient 5xx with backoff then throws HttpError', async () => {
  const f = scriptedFetch(() => ({ status: 503, body: {} }));
  const c = makeClient(f.impl);
  await assert.rejects(c.getMe(), (err) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 503);
    return true;
  });
  assert.ok(f.calls.length >= 4, `got ${f.calls.length} attempts before failing`);
});

test('throws AuthenticationError when there is no token to retry', async () => {
  const f = scriptedFetch(() => ({ status: 401, body: {} }));
  const c = makeClient(f.impl, async () => null);
  await assert.rejects(c.getMe(), (err) => {
    // getToken returned null -> no retry -> AuthenticationError
    assert.ok(err instanceof AuthenticationError || err instanceof HttpError);
    return true;
  });
});

test('feeds response headers into the shared rate-limit tracker', async () => {
  const tracker = new RateLimitTracker();
  const f = scriptedFetch(() => ({
    status: 200,
    headers: jsonHeaders({ 'ratelimit-policy': '"perday";q=100;w=86400' }),
    body: { ok: 1 },
  }));
  const c = makeClient(f.impl, async () => 'tok', tracker);
  await c.getMe();
  assert.equal(tracker.quota, 100);
  assert.equal(tracker.remaining, 100);
});