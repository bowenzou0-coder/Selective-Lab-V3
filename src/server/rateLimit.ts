import type { Response } from 'express';

export const AI_RATE_LIMIT_MAX_REQUESTS = 5;
export const AI_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
  resetAtMs: number;
}

export interface SlidingWindowRateLimiterOptions {
  maxRequests: number;
  windowMs: number;
  now?: () => number;
  /** Periodic full sweep cadence to prevent unbounded memory growth across many keys. */
  sweepEvery?: number;
}

/**
 * Per-key sliding-window rate limiter with automatic stale-timestamp pruning.
 * Designed for expensive AI endpoints (per-user, per-action buckets).
 */
export class SlidingWindowRateLimiter {
  readonly maxRequests: number;
  readonly windowMs: number;
  private readonly now: () => number;
  private readonly sweepEvery: number;
  private readonly buckets = new Map<string, number[]>();
  private opsSinceSweep = 0;

  constructor(options: SlidingWindowRateLimiterOptions) {
    if (!Number.isInteger(options.maxRequests) || options.maxRequests < 1) {
      throw new Error('maxRequests must be a positive integer.');
    }
    if (!Number.isFinite(options.windowMs) || options.windowMs <= 0) {
      throw new Error('windowMs must be a positive number.');
    }
    this.maxRequests = options.maxRequests;
    this.windowMs = options.windowMs;
    this.now = options.now ?? (() => Date.now());
    this.sweepEvery = options.sweepEvery ?? 100;
  }

  consume(key: string): RateLimitResult {
    const nowMs = this.now();
    const cutoff = nowMs - this.windowMs;

    this.opsSinceSweep += 1;
    if (this.opsSinceSweep >= this.sweepEvery) {
      this.opsSinceSweep = 0;
      this.prune(nowMs);
    }

    const existing = this.buckets.get(key);
    const active = existing ? existing.filter((ts) => ts > cutoff) : [];

    if (active.length >= this.maxRequests) {
      this.buckets.set(key, active);
      const resetAtMs = active[0] + this.windowMs;
      const retryAfterSeconds = Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000));
      return {
        allowed: false,
        limit: this.maxRequests,
        remaining: 0,
        retryAfterSeconds,
        resetAtMs,
      };
    }

    active.push(nowMs);
    this.buckets.set(key, active);
    const resetAtMs = active[0] + this.windowMs;
    return {
      allowed: true,
      limit: this.maxRequests,
      remaining: Math.max(0, this.maxRequests - active.length),
      retryAfterSeconds: 0,
      resetAtMs,
    };
  }

  /** Remove all expired timestamps and empty buckets. Returns number of remaining active buckets. */
  prune(nowMs = this.now()): number {
    const cutoff = nowMs - this.windowMs;
    for (const [key, timestamps] of this.buckets) {
      if (timestamps.length === 0 || timestamps[timestamps.length - 1] <= cutoff) {
        this.buckets.delete(key);
        continue;
      }
      if (timestamps[0] <= cutoff) {
        const fresh = timestamps.filter((ts) => ts > cutoff);
        if (fresh.length === 0) {
          this.buckets.delete(key);
        } else {
          this.buckets.set(key, fresh);
        }
      }
    }
    return this.buckets.size;
  }

  /** Reset a single bucket key or all buckets (handy in tests). */
  reset(key?: string): void {
    if (key !== undefined) {
      this.buckets.delete(key);
      return;
    }
    this.buckets.clear();
    this.opsSinceSweep = 0;
  }

  get bucketCount(): number {
    return this.buckets.size;
  }
}

export function createAiRateLimiter(
  options: Partial<SlidingWindowRateLimiterOptions> = {}
): SlidingWindowRateLimiter {
  return new SlidingWindowRateLimiter({
    maxRequests: options.maxRequests ?? AI_RATE_LIMIT_MAX_REQUESTS,
    windowMs: options.windowMs ?? AI_RATE_LIMIT_WINDOW_MS,
    now: options.now,
    sweepEvery: options.sweepEvery,
  });
}

/**
 * Enforce a per-user AI rate limit bucket on an Express response.
 * Returns true if the request is allowed; writes HTTP 429 + Retry-After and returns false otherwise.
 */
export function enforceAiRateLimit(
  limiter: SlidingWindowRateLimiter,
  action: 'recalibrate' | 'writing_evaluate' | 'benchmark_analyze',
  studentId: string,
  res: Response,
  actionLabel: string
): boolean {
  const decision = limiter.consume(`${action}:${studentId}`);
  if (decision.allowed) return true;

  res.setHeader('Retry-After', String(decision.retryAfterSeconds));
  res.status(429).json({
    error: `Too many ${actionLabel} requests. Please wait ${decision.retryAfterSeconds} seconds before trying again.`,
    retryAfterSeconds: decision.retryAfterSeconds,
    limit: decision.limit,
    windowSeconds: Math.round(limiter.windowMs / 1000),
  });
  return false;
}
