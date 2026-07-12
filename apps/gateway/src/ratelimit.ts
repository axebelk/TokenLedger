import type { Redis } from "@tokentrail/queue";
import type { RateLimitDecision, RateLimiter } from "./types.js";

function windowInfo(nowMs: number): { window: number; retryAfterS: number } {
  const window = Math.floor(nowMs / 60_000);
  return { window, retryAfterS: Math.ceil(((window + 1) * 60_000 - nowMs) / 1000) };
}

/**
 * Fixed 60 s window counter in Redis (INCR + EXPIRE). Coarser than a sliding
 * window but one round-trip and shared across gateway replicas. Fails open —
 * rate limiting must never take traffic down with Redis.
 */
export class RedisRateLimiter implements RateLimiter {
  constructor(private redis: Redis) {}

  async check(bucketKey: string, rpmLimit: number): Promise<RateLimitDecision> {
    const { window, retryAfterS } = windowInfo(Date.now());
    try {
      const redisKey = `rl:${bucketKey}:${window}`;
      const count = await this.redis.incr(redisKey);
      if (count === 1) await this.redis.expire(redisKey, 120);
      return { allowed: count <= rpmLimit, retryAfterS };
    } catch {
      return { allowed: true, retryAfterS: 0 };
    }
  }
}

/** Single-process variant for tests and database-less dev runs. */
export class MemoryRateLimiter implements RateLimiter {
  private counts = new Map<string, number>();

  async check(bucketKey: string, rpmLimit: number): Promise<RateLimitDecision> {
    const { window, retryAfterS } = windowInfo(Date.now());
    const key = `${bucketKey}:${window}`;
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    if (this.counts.size > 10_000) this.counts.clear(); // crude bound; windows expire anyway
    return { allowed: count <= rpmLimit, retryAfterS };
  }
}
