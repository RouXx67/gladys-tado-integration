import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RateLimitTracker } from '../src/tado/ratelimit.js';

let now = Date.UTC(2026, 0, 1, 10, 0, 0);
const clockNow = () => now;

test('parses the tado° ratelimit headers', () => {
  const t = new RateLimitTracker({ now: clockNow });
  t.track({ 'ratelimit-policy': '"perday";q=100;w=86400', ratelimit: '"perday";r=42' });
  assert.equal(t.quota, 100);
  assert.equal(t.remaining, 42);
  assert.equal(t.isFreeTier, true);
  assert.equal(t.hasAuthority(), true);
});

test('treats the subscribed tier (20000/day) as not free', () => {
  const t = new RateLimitTracker({ now: clockNow });
  t.track({ 'ratelimit-policy': '"perday";q=20000;w=86400', ratelimit: '"perday";r=19000' });
  assert.equal(t.quota, 20000);
  assert.equal(t.isFreeTier, false);
});

test('neverSeen tracker has no authority and returns the floor interval', () => {
  const t = new RateLimitTracker({ now: clockNow });
  const interval = t.suggestInterval(4, 900000);
  assert.equal(interval, 900000);
});

test('spreads the remaining budget over the reset window', () => {
  const t = new RateLimitTracker({ now: clockNow });
  // 10:00 local, quota 100/day, 50 remaining -> ask 4 calls per cycle.
  t.track({ 'ratelimit-policy': '"perday";q=100;w=86400', ratelimit: '"perday";r=50' });
  const windowMs = 24 * 60 * 60 * 1000;
  const expected = (windowMs / (50 - 3)) * 4; // small safety margin applied
  const interval = t.suggestInterval(4, 60 * 1000);
  assert.ok(interval > 60 * 1000, 'should extend beyond the floor on a free tier');
  assert.ok(Math.abs(interval - expected) < expected * 0.02, `${interval} ~= ${expected}`);
});

test('returns a full day when the budget is exhausted', () => {
  const t = new RateLimitTracker({ now: clockNow });
  t.track({ ratelimit: '"perday";r=0;t=7200' });
  assert.equal(t.suggestInterval(2, 60 * 1000), 24 * 60 * 60 * 1000);
});

test('parses retry-after time-to-reset from the header', () => {
  const t = new RateLimitTracker({ now: clockNow });
  t.track({ ratelimit: '"perday";r=0;t=3600' });
  assert.equal(t._resetAt, now + 3600 * 1000);
});