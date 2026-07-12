import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { baseEnv, databaseEnv, loadConfig, redisEnv } from "@tokentrail/config";
import { createLogger } from "@tokentrail/telemetry";
import { createPrismaClient } from "@tokentrail/db";
import {
  createRedis, createWorker, CONSUMER_GROUPS, QUEUES, STREAMS, type Job,
} from "@tokentrail/queue";
import type { ExportJobData } from "@tokentrail/shared";
import { startIngest } from "./ingest/consumer.js";
import { runExportJob } from "./jobs/export-csv.js";

const config = loadConfig(
  baseEnv.merge(databaseEnv).merge(redisEnv).extend({
    INGEST_BATCH_SIZE: z.coerce.number().int().min(1).max(5000).default(500),
    INGEST_BLOCK_MS: z.coerce.number().int().min(50).max(5000).default(200),
    EXPORTS_DIR: z.string().optional(),
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

// More BullMQ processors (notify, retention, reconcile…) register here as they land.

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down: finishing current batch");
  await ingest.stop();
  await exportWorker.close();
  await prisma.$disconnect();
  redis.disconnect();
  bullRedis.disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

logger.info("TokenTrail worker started (ingest consumer active)");
