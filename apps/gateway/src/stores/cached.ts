import type { Redis } from "@tokentrail/queue";
import type { KeyStore, ResolvedKeyContext } from "../types.js";

const REDIS_TTL_S = 60;
const LOCAL_TTL_MS = 5_000;
const NEGATIVE = "∅"; // cache unknown keys too — repeated garbage keys must not hammer PG

interface LocalEntry {
  value: ResolvedKeyContext | null;
  expiresAt: number;
}

/**
 * Two-tier VK cache: in-proc map (5 s) → Redis (60 s) → inner store.
 * Revocations propagate via the `invalidate:vk:*` pub/sub channel published
 * by the control-plane API (≤ 5 s effect, SRS FR-KEY-3).
 */
export class CachedKeyStore implements KeyStore {
  private local = new Map<string, LocalEntry>();

  constructor(
    private inner: KeyStore,
    private redis: Redis,
  ) {}

  async resolve(keyHash: string): Promise<ResolvedKeyContext | null> {
    const now = Date.now();
    const cached = this.local.get(keyHash);
    if (cached && cached.expiresAt > now) return cached.value;

    const redisKey = `vk:${keyHash}`;
    try {
      const fromRedis = await this.redis.get(redisKey);
      if (fromRedis !== null) {
        const value = fromRedis === NEGATIVE ? null : reviveContext(fromRedis);
        this.local.set(keyHash, { value, expiresAt: now + LOCAL_TTL_MS });
        return value;
      }
    } catch {
      // Redis down → fail open to the inner store (in-proc cache still bounds load)
    }

    const value = await this.inner.resolve(keyHash);
    this.local.set(keyHash, { value, expiresAt: now + LOCAL_TTL_MS });
    try {
      await this.redis.set(redisKey, value ? JSON.stringify(value) : NEGATIVE, "EX", REDIS_TTL_S);
    } catch {
      /* best-effort */
    }
    return value;
  }

  invalidate(keyHash: string): void {
    this.local.delete(keyHash);
  }

  /** Wire up pub/sub invalidation. `subscriber` must be a dedicated connection. */
  async subscribeInvalidations(subscriber: Redis): Promise<void> {
    await subscriber.psubscribe("invalidate:vk:*");
    subscriber.on("pmessage", (_pattern, channel) => {
      const keyHash = channel.slice("invalidate:vk:".length);
      this.invalidate(keyHash);
      this.redis.del(`vk:${keyHash}`).catch(() => {});
    });
  }
}

function reviveContext(json: string): ResolvedKeyContext {
  const parsed = JSON.parse(json) as ResolvedKeyContext & { expiresAt?: string | Date };
  if (parsed.expiresAt) parsed.expiresAt = new Date(parsed.expiresAt);
  return parsed;
}
