import type { Logger } from "@tokentrail/telemetry";
import type { PrismaClient } from "@tokentrail/db";
import {
  CONSUMER_GROUPS,
  STREAMS,
  type Redis,
  type UsageEventMessage,
} from "@tokentrail/queue";
import { hostname } from "node:os";
import { persistBatch } from "./persist.js";

/** Idempotently (re)create the stream + consumer group. */
async function ensureConsumerGroup(redis: Redis): Promise<void> {
  try {
    await redis.xgroup("CREATE", STREAMS.usageEvents, CONSUMER_GROUPS.ingest, "0", "MKSTREAM");
  } catch (err) {
    if (!(err instanceof Error && err.message.includes("BUSYGROUP"))) throw err;
  }
}

interface IngestOptions {
  redis: Redis;
  prisma: PrismaClient;
  logger: Logger;
  batchSize: number;
  blockMs: number;
}

export interface IngestHandle {
  stop(): Promise<void>;
}

type StreamEntry = [id: string, fields: string[]];
type StreamReadReply = [stream: string, entries: StreamEntry[]][] | null;

/**
 * Usage-event ingestion: XREADGROUP batches → persistBatch (idempotent insert
 * + rollup upserts in one transaction) → XACK. At-least-once delivery plus
 * insert-returning-ids means redelivered events can never double-charge.
 */
export function startIngest(opts: IngestOptions): IngestHandle {
  const { redis, prisma, logger, batchSize, blockMs } = opts;
  const consumerName = `${hostname()}:${process.pid}`;
  let running = true;
  let loopDone: Promise<void>;

  async function loop() {
    while (running) {
      try {
        const reply = (await redis.xreadgroup(
          "GROUP", CONSUMER_GROUPS.ingest, consumerName,
          "COUNT", batchSize,
          "BLOCK", blockMs,
          "STREAMS", STREAMS.usageEvents, ">",
        )) as StreamReadReply;

        const entries = reply?.[0]?.[1] ?? [];
        if (entries.length === 0) continue;

        const { events, ackIds, invalid } = decodeBatch(entries);
        if (invalid.length > 0) {
          logger.warn({ count: invalid.length }, "invalid usage events sent to DLQ");
          for (const [id, payload] of invalid) {
            await redis.xadd(STREAMS.usageDlq, "*", "payload", payload, "sourceId", id);
          }
        }
        if (events.length > 0) {
          const inserted = await persistBatch(prisma, events);
          if (inserted < events.length) {
            logger.debug({ received: events.length, inserted }, "skipped redelivered duplicates");
          }
        }
        if (ackIds.length > 0) {
          await redis.xack(STREAMS.usageEvents, CONSUMER_GROUPS.ingest, ...ackIds);
        }
      } catch (err) {
        if (!running) break;
        // The stream/group can vanish at runtime (Redis restart without
        // persistence, manual flush). Recreate it and continue instead of
        // wedging the ingest loop forever.
        if (err instanceof Error && err.message.includes("NOGROUP")) {
          logger.warn("ingest consumer group missing; recreating");
          await ensureConsumerGroup(redis).catch(() => {});
          continue;
        }
        logger.error({ err }, "ingest batch failed; backing off 1s");
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  loopDone = loop();

  return {
    async stop() {
      running = false;
      await loopDone;
    },
  };
}

function decodeBatch(entries: StreamEntry[]): {
  events: UsageEventMessage[];
  ackIds: string[];
  invalid: [id: string, payload: string][];
} {
  const events: UsageEventMessage[] = [];
  const ackIds: string[] = [];
  const invalid: [string, string][] = [];

  for (const [id, fields] of entries) {
    const payloadIndex = fields.indexOf("payload");
    const payload = payloadIndex >= 0 ? fields[payloadIndex + 1] : undefined;
    ackIds.push(id); // poison messages are acked after DLQ, never re-looped
    if (!payload) {
      invalid.push([id, ""]);
      continue;
    }
    try {
      const event = JSON.parse(payload) as UsageEventMessage;
      if (!event.id || !event.workspaceId || !event.occurredAt) throw new Error("missing fields");
      events.push(event);
    } catch {
      invalid.push([id, payload]);
    }
  }
  return { events, ackIds, invalid };
}
