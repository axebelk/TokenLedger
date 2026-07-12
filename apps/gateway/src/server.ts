import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { Counter } from "prom-client";
import { keyRingFromEnv } from "@tokentrail/auth";
import { createLogger, createMetricsRegistry } from "@tokentrail/telemetry";
import { createRedis, pingRedis } from "@tokentrail/queue";
import { entitled, initLicensing } from "@tokentrail/ee-licensing";
import { RedisBudgetGuard } from "@tokentrail/ee-gateway";
import type { GatewayConfig } from "./config.js";
import type { GatewayDeps } from "./types.js";
import { makeGatewayHandler } from "./proxy/pipeline.js";
import { PgPricingSource, StaticPricingSource } from "./pricing.js";
import { MemoryRateLimiter, RedisRateLimiter } from "./ratelimit.js";
import { RedisStreamSink } from "./sink.js";
import { CachedKeyStore } from "./stores/cached.js";
import { createPgPool, PgCredentialStore, PgKeyStore } from "./stores/db.js";
import { InMemoryCredentialStore, InMemoryKeyStore } from "./stores/memory.js";

export type GatewayServer = Awaited<ReturnType<typeof buildServer>>;

export async function buildServer(config: GatewayConfig, overrides?: Partial<GatewayDeps>) {
  const logger = createLogger("gateway", config.LOG_LEVEL);
  const registry = createMetricsRegistry("gateway");
  const redis = createRedis(config.REDIS_URL);

  const eventsDropped = new Counter({
    name: "tokentrail_events_dropped_total",
    help: "Usage events dropped after the retry buffer overflowed",
    registers: [registry],
  });

  // ── Enterprise gates ─────────────────────────────────────────────────────
  const licensing = initLicensing(config.LICENSE_KEY, config.LICENSE_PUBLIC_KEY);
  if (config.LICENSE_KEY && !licensing.license) {
    logger.warn({ reason: licensing.reason }, "LICENSE_KEY present but invalid — running community edition");
  }

  // ── Dependency wiring: PG-backed when configured, in-memory otherwise ────
  const ring = config.TOKENTRAIL_MASTER_KEY ? keyRingFromEnv(config.TOKENTRAIL_MASTER_KEY) : null;
  let deps: GatewayDeps;
  let pricingSource: PgPricingSource | undefined;
  const subscriber = createRedis(config.REDIS_URL); // pub/sub needs its own connection
  if (config.DATABASE_URL && !overrides?.keyStore) {
    const pool = createPgPool(config.DATABASE_URL);
    const keyStore = new CachedKeyStore(new PgKeyStore(pool), redis);
    await keyStore.subscribeInvalidations(subscriber).catch((err) => {
      logger.warn({ err }, "VK invalidation subscription failed — relying on TTLs");
    });
    pricingSource = new PgPricingSource(pool, logger);
    await pricingSource.start();
    deps = {
      keyStore,
      credentialStore: new PgCredentialStore(pool, ring),
      sink: new RedisStreamSink(redis, logger, eventsDropped),
      pricing: pricingSource,
      rateLimiter: new RedisRateLimiter(redis),
      ...overrides,
    };
  } else {
    if (!overrides?.keyStore) {
      logger.warn("DATABASE_URL not set — gateway running with empty in-memory stores (dev only)");
    }
    deps = {
      keyStore: new InMemoryKeyStore(),
      credentialStore: new InMemoryCredentialStore(),
      sink: new RedisStreamSink(redis, logger, eventsDropped),
      pricing: new StaticPricingSource(),
      rateLimiter: new MemoryRateLimiter(),
      ...overrides,
    };
  }
  if (entitled("budget_enforcement") && !deps.budgetGuard) {
    deps.budgetGuard = new RedisBudgetGuard(redis);
    logger.info("enterprise budget enforcement active");
  }

  const app = Fastify({
    loggerInstance: logger,
    genReqId: () => `req_${randomUUID()}`,
    disableRequestLogging: true, // hot path — request logs are metrics' job
  });

  // A proxy must never parse request bodies — they pipe upstream untouched.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", (_request, payload, done) => done(null, payload));

  app.addHook("onSend", async (request, reply) => {
    reply.header("x-tokentrail-request-id", request.id);
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  // Readiness deliberately checks Redis only: the gateway must stay ready
  // through a Postgres outage (FAIL_OPEN, docs/03 §9).
  app.get("/readyz", async (_request, reply) => {
    if (await pingRedis(redis)) return { status: "ready" };
    if (config.GATEWAY_FAILURE_POLICY === "FAIL_OPEN") {
      return { status: "ready", degraded: ["redis"] };
    }
    return reply.status(503).send({ status: "not_ready", failing: ["redis"] });
  });

  app.get("/metrics", async (_request, reply) => {
    reply.type(registry.contentType);
    return registry.metrics();
  });

  // Native passthrough surface: /gw/{provider}/*
  app.all("/gw/:provider/*", makeGatewayHandler(deps, logger));

  // Unified OpenAI-compatible surface — translation lands in Phase 2.
  app.post("/gw/v1/chat/completions", async (request, reply) =>
    reply.status(501).send({
      error: { type: "not_implemented", message: "Unified endpoint lands in Phase 2", requestId: request.id },
    }),
  );

  return { app, redis, subscriber, deps, pricingSource };
}
