import { z } from "zod";
import { baseEnv, databaseEnv, loadConfig, redisEnv } from "@tokentrail/config";
import { createLogger } from "@tokentrail/telemetry";
import { createPrismaClient } from "@tokentrail/db";
import { createRedis, CONSUMER_GROUPS, STREAMS } from "@tokentrail/queue";
import { entitled, initLicensing } from "@tokentrail/ee-licensing";
import { startBudgetEngine, type BudgetEngineHandle } from "@tokentrail/ee-worker";
import { startIngest } from "./ingest/consumer.js";

const config = loadConfig(
  baseEnv.merge(databaseEnv).merge(redisEnv).extend({
    INGEST_BATCH_SIZE: z.coerce.number().int().min(1).max(5000).default(500),
    INGEST_BLOCK_MS: z.coerce.number().int().min(50).max(5000).default(200),
    LICENSE_KEY: z.string().optional(),
    LICENSE_PUBLIC_KEY: z.string().optional(),
  }),
);

const logger = createLogger("worker", config.LOG_LEVEL);
const prisma = createPrismaClient(config.DATABASE_URL);
const redis = createRedis(config.REDIS_URL);

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

// ── Enterprise: budget engine (block flags + threshold notifications) ──────
let budgetEngine: BudgetEngineHandle | undefined;
const licensing = initLicensing(config.LICENSE_KEY, config.LICENSE_PUBLIC_KEY);
if (config.LICENSE_KEY && !licensing.license) {
  logger.warn({ reason: licensing.reason }, "LICENSE_KEY present but invalid — running community edition");
}
if (entitled("budget_enforcement")) {
  budgetEngine = startBudgetEngine({ prisma, redis, logger });
  logger.info("enterprise budget engine active");
}

// BullMQ processors (export-csv, notify, retention, reconcile…)
// register here from ./jobs as they land in Phases 2–4 (docs/10 §4).

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down: finishing current batch");
  budgetEngine?.stop();
  await ingest.stop();
  await prisma.$disconnect();
  redis.disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

logger.info("TokenTrail worker started (ingest consumer active)");
