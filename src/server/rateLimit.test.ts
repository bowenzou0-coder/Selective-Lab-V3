import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AI_RATE_LIMIT_MAX_REQUESTS,
  AI_RATE_LIMIT_WINDOW_MS,
  SlidingWindowRateLimiter,
  createAiRateLimiter,
} from './rateLimit.ts';

test('SlidingWindowRateLimiter allows up to limit, rejects next with Retry-After, isolates keys, and expires window', () => {
  let nowMs = 1_000_000;
  const limiter = new SlidingWindowRateLimiter({
    maxRequests: 5,
    windowMs: 10 * 60 * 1000,
    now: () => nowMs,
    sweepEvery: 50,
  });

  // 5 requests allowed for user A
  for (let i = 0; i < 5; i++) {
    const res = limiter.consume('recalibrate:user_a');
    assert.equal(res.allowed, true);
    assert.equal(res.limit, 5);
    assert.equal(res.remaining, 4 - i);
    assert.equal(res.retryAfterSeconds, 0);
    nowMs += 1_000;
  }

  // 6th request within window is blocked with accurate retryAfterSeconds
  const blocked = limiter.consume('recalibrate:user_a');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  // First request was at 1_000_000, current time is 1_005_000 -> 595s left
  assert.equal(blocked.retryAfterSeconds, 595);

  // Separate user bucket is unaffected
  const userB = limiter.consume('recalibrate:user_b');
  assert.equal(userB.allowed, true);
  assert.equal(userB.remaining, 4);

  // Separate action bucket for same user is unaffected
  const otherAction = limiter.consume('writing_evaluate:user_a');
  assert.equal(otherAction.allowed, true);
  assert.equal(otherAction.remaining, 4);

  // Advance just past expiry of the 1st timestamp (1_000_000 + 600_000 = 1_600_000)
  nowMs = 1_600_000;
  const afterFirstExpiry = limiter.consume('recalibrate:user_a');
  assert.equal(afterFirstExpiry.allowed, true);
  assert.equal(afterFirstExpiry.remaining, 0);

  // Advance well past entire window -> prune clears all stale buckets cleanly
  nowMs = 3_000_000;
  assert.equal(limiter.prune(), 0);
  assert.equal(limiter.bucketCount, 0);

  // Reset clears buckets immediately
  limiter.consume('recalibrate:user_c');
  assert.equal(limiter.bucketCount, 1);
  limiter.reset('recalibrate:user_c');
  assert.equal(limiter.bucketCount, 0);

  limiter.consume('recalibrate:user_d');
  limiter.consume('recalibrate:user_e');
  assert.equal(limiter.bucketCount, 2);
  limiter.reset();
  assert.equal(limiter.bucketCount, 0);
});

test('createAiRateLimiter defaults to 5 requests per 10 minutes', () => {
  const limiter = createAiRateLimiter();
  assert.equal(limiter.maxRequests, AI_RATE_LIMIT_MAX_REQUESTS);
  assert.equal(limiter.windowMs, AI_RATE_LIMIT_WINDOW_MS);
  assert.equal(limiter.maxRequests, 5);
  assert.equal(limiter.windowMs, 600_000);
});
