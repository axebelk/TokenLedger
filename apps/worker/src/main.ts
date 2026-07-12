import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { baseEnv, databaseEnv, loadConfig, redisEnv } from "@tokentrail/config";
import { createLogger } from "@tokentrail/telemetry";
import { createPrismaClient } from "@tokentrail/db";
import {
  createQueue, createRedis, createWorker, CONSUMER_GROUPS, HOUSEKEEPING, QUEUES, STREAMS, type Job,
} from "@tokentrail/queue";
import type { ExportJobData } from "@tokentrail/shared";
import { startIngest } from "./ingest/consumer.js";
import { runExportJob } from "./jobs/export-csv.js";
import { runRetention } from "./jobs/retention.js";
import { runReconcile } from "./jobs/reconcile.js";

const config = loadConfig(
  baseEnv.merge(databaseEnv).merge(redisEnv).extend({
    INGEST_BATCH_SIZE: z.coerce.number().int().min(1).max(5000).default(500),
    INGEST_BLOCK_MS: z.coerce.number().int().min(50).max(5000).default(200),
    EXPORTS_DIR: z.string().optional(),
    EVENT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  }),
);

const logger = createLogger("worker", config.LOG_LEVEL);
const prisma = createPrismaClient(config.DATABASE_URL);
const redis = createRedis(config.REDIS_URL);
const exportsDir = config.EXPORTS_DIR ?? join(tmpdir(), "tokentrail-exports");

// Create the stream + consumer group idempotently before consuming.
try {
  await redis.xgroup("CREATE", STREAMS.usageEvents, CONSUMER_GROUPS.ingest, "0", "MKSTREAM");
  logger.info({ stream: STREAMS.usageEvents }, "created ingest consumer group");
} catch (err) {
  if (!(err instanceof Error && err.message.includes("BUSYGROUP"))) throw err;
}

const ingest = startIngest({
  redis,
  prisma,
  logger,
  batchSize: config.INGEST_BATCH_SIZE,
  blockMs: config.INGEST_BLOCK_MS,
});

// ── BullMQ: async CSV export processor ──────────────────────────────────────
// A dedicated Redis connection for BullMQ (it issues blocking commands).
const bullRedis = createRedis(config.REDIS_URL);
const exportWorker = createWorker<ExportJobData>(
  QUEUES.exportCsv,
  (job: Job<ExportJobData>) => runExportJob(prisma, exportsDir, job.data.exportJobId, logger),
  bullRedis,
);
exportWorker.on("failed", (job, err) => logger.error({ err, jobId: job?.data.exportJobId }, "export worker job failed"));
logger.info({ exportsDir }, "export-csv worker active");

// ── BullMQ: daily housekeeping (retention + reconcile) ──────────────────────
const housekeepingQueue = createQueue(QUEUES.housekeeping, bullRedis);
const housekeepingWorker = createWorker(
  QUEUES.housekeeping,
  async (job: Job) => {
    if (job.name === HOUSEKEEPING.retention) {
      return runRetention(prisma, exportsDir, config.EVENT_RETENTION_DAYS, logger);
    }
    if (job.name === HOUSEKEEPING.reconcile) {
      return runReconcile(prisma, logger);
    }
    logger.warn({ name: job.name }, "unknown housekeeping job");
  },
  bullRedis,
  1,
);
housekeepingWorker.on("failed", (job, err) => logger.error({ err, name: job?.name }, "housekeeping job failed"));

// Register the repeatable schedules idempotently (BullMQ dedupes by repeat key).
await housekeepingQueue.add(HOUSEKEEPING.retention, {}, {
  repeat: { pattern: "15 3 * * *" }, // daily 03:15 UTC
  removeOnComplete: 30, removeOnFail: 30,
});
await housekeepingQueue.add(HOUSEKEEPING.reconcile, {}, {
  repeat: { pattern: "45 3 * * *" }, // daily 03:45 UTC
  removeOnComplete: 30, removeOnFail: 30,
});
logger.info({ retentionDays: config.EVENT_RETENTION_DAYS }, "housekeeping scheduled (retention + reconcile daily)");

// More BullMQ processors (notify, scheduled reports…) register here as they land.

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down: finishing current batch");
  await ingest.stop();
  await exportWorker.close();
  await housekeepingWorker.close();
  await prisma.$disconnect();
  redis.disconnect();
  bullRedis.disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

logger.info("TokenTrail worker started (ingest consumer active)");
