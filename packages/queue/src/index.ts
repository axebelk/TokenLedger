import { Redis } from "ioredis";
import { Queue, Worker, type Job, type Processor } from "bullmq";

export { Redis, Worker, Queue, type Job };
import type { CostBasis, EventStatus, Provider } from "@tokentrail/shared";

/** Single registry of stream/queue/channel names — no magic strings elsewhere. */
export const STREAMS = {
  usageEvents: "usage:events",
  usageDlq: "usage:dlq",
} as const;

export const CONSUMER_GROUPS = {
  ingest: "ingest",
} as const;

export const QUEUES = {
  exportCsv: "export-csv",
  housekeeping: "housekeeping",
  notify: "notify",
  scheduledReport: "scheduled-report",
  pricingSync: "pricing-sync",
  retention: "retention",
  reconcile: "reconcile",
  budgetRefresh: "budget-refresh",
  budgetRollover: "budget-rollover",
  poolHealth: "pool-health",
} as const;

/** Named jobs on the housekeeping queue (repeatable). */
export const HOUSEKEEPING = {
  retention: "retention",
  reconcile: "reconcile",
} as const;

export const CHANNELS = {
  invalidateVk: (keyHash: string) => `invalidate:vk:${keyHash}`,
  invalidateCred: (credentialId: string) => `invalidate:cred:${credentialId}`,
} as const;

/** Wire shape of a usage event on the stream (validated by the worker before insert). */
export interface UsageEventMessage {
  id: string; // uuid v7, minted at gateway — ingestion idempotency key
  occurredAt: string; // ISO 8601
  workspaceId: string;
  projectId: string;
  teamId?: string;
  userId: string;
  virtualKeyId: string;
  credentialId?: string;
  poolId?: string;
  provider: Provider;
  modelRaw: string;
  model: string;
  endpoint: string;
  requestId: string;
  status: EventStatus;
  httpStatus: number;
  streamed: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: string; // decimal as string — never floats for money
  unitPrices?: { in: string; out: string; cr: string; cw: string; source: string };
  costBasis: CostBasis;
  latencyMs: number;
  ttftMs?: number;
  tags?: string[];
}

export function createRedis(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableAutoPipelining: true,
    lazyConnect: true, // first command connects; keeps redis-less dev/test runs quiet
  });
}

/**
 * Liveness-safe PING. With maxRetriesPerRequest: null (required by BullMQ),
 * commands queue forever while Redis is down — a bare `await redis.ping()`
 * would hang health endpoints instead of reporting degradation.
 */
export async function pingRedis(redis: Redis, timeoutMs = 500): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    return await Promise.race([
      redis.ping().then((r) => r === "PONG", () => false),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function publishUsageEvent(redis: Redis, event: UsageEventMessage): Promise<void> {
  await redis.xadd(
    STREAMS.usageEvents,
    "MAXLEN", "~", "1000000",
    "*",
    "payload", JSON.stringify(event),
  );
}

export function createQueue(name: string, redis: Redis): Queue {
  return new Queue(name, { connection: redis });
}

export function createWorker<T>(
  name: string,
  processor: Processor<T>,
  redis: Redis,
  concurrency = 2,
): Worker<T> {
  return new Worker<T>(name, processor, { connection: redis, concurrency });
}
