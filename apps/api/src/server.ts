import Fastify, { type FastifyError } from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { DomainError } from "@tokenledger/shared";
import { keyRingFromEnv } from "@tokenledger/auth";
import { createLogger, createMetricsRegistry } from "@tokenledger/telemetry";
import { createPrismaClient } from "@tokenledger/db";
import { createQueue, createRedis, pingRedis, QUEUES } from "@tokenledger/queue";
import type { ApiConfig } from "./config.js";
import { makeAuthenticate, makeSuperAdminGuard, parseSuperAdmins } from "./plugins/guards.js";
import { registerAuthModule } from "./modules/auth.js";
import { registerAdminModule } from "./modules/admin.js";
import { registerOrgModule } from "./modules/org.js";
import { registerTeamsModule } from "./modules/teams.js";
import { registerCredentialsModule } from "./modules/credentials.js";
import { registerKeysModule } from "./modules/keys.js";
import { registerAnalyticsModule } from "./modules/analytics.js";
import { registerExportsModule } from "./modules/exports.js";
import { registerInvitationsModule } from "./modules/invitations.js";
import { registerBudgetsModule } from "./modules/budgets.js";
import { registerPricingModule } from "./modules/pricing.js";
import { createMailer } from "./lib/mailer.js";
import { activeLicense, initLicensing, EE_FEATURES, entitled } from "@tokenledger/ee-licensing";

export type ApiServer = Awaited<ReturnType<typeof buildServer>>;

export async function buildServer(config: ApiConfig) {
  const logger = createLogger("api", config.LOG_LEVEL);
  const registry = createMetricsRegistry("api");
  const prisma = createPrismaClient(config.DATABASE_URL);
  const redis = createRedis(config.REDIS_URL);
  const exportQueue = createQueue(QUEUES.exportCsv, redis);
  const ring = config.TOKENLEDGER_MASTER_KEY ? keyRingFromEnv(config.TOKENLEDGER_MASTER_KEY) : null;

  const licensing = initLicensing(config.LICENSE_KEY, config.LICENSE_PUBLIC_KEY);
  if (config.LICENSE_KEY && !licensing.license) {
    logger.warn({ reason: licensing.reason }, "LICENSE_KEY present but invalid — running community edition");
  }

  const app = Fastify({
    loggerInstance: logger,
    genReqId: () => randomUUID(),
    disableRequestLogging: config.NODE_ENV === "production",
  });

  await app.register(helmet);
  await app.register(cors, { origin: config.PUBLIC_BASE_URL, credentials: true });
  await app.register(cookie);
  // Per-IP rate limit on the public surface. Modules opt-in per-route with
  // tighter limits (e.g. /auth/login, /workspaces/:ws/exports/:id/download).
  // No `redis:` passed → plugin uses its default LocalStore. A future
  // enhancement can share counters across API replicas.
  await app.register(rateLimit, {
    global: false,
    nameSpace: "tl-api-ip:",
    max: 300, // 5 req/s burst headroom for legitimate API clients
    timeWindow: "1 minute",
    errorResponseBuilder: (_req, context) => ({
      type: "https://tokenledger.dev/problems/rate_limited",
      title: "rate_limited",
      status: 429,
      detail: `Too many requests; retry in ${context.after}.`,
      retryAfterSeconds: Math.ceil(context.ttl / 1000),
    }),
  });

  // RFC 9457 problem+json for everything that escapes a handler.
  app.setErrorHandler((error: FastifyError | ZodError | DomainError, request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).type("application/problem+json").send({
        type: "https://tokenledger.dev/problems/validation_failed",
        title: "validation_failed",
        status: 400,
        detail: "Request validation failed",
        requestId: request.id,
        errors: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    if (error instanceof DomainError) {
      return reply
        .status(error.httpStatus)
        .type("application/problem+json")
        .send({
          type: `https://tokenledger.dev/problems/${error.code}`,
          title: error.code,
          status: error.httpStatus,
          detail: error.message,
          requestId: request.id,
          ...(error.details ? { errors: error.details } : {}),
        });
    }
    const fastifyError = error as FastifyError;
    const status =
      fastifyError.statusCode && fastifyError.statusCode >= 400 ? fastifyError.statusCode : 500;
    if (status >= 500) request.log.error({ err: error }, "unhandled error");
    return reply.status(status).type("application/problem+json").send({
      type: "about:blank",
      title: status >= 500 ? "Internal Server Error" : error.message,
      status,
      requestId: request.id,
    });
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/readyz", async (_request, reply) => {
    const checks = { postgres: false, redis: false };
    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.postgres = true;
    } catch {
      /* not ready */
    }
    checks.redis = await pingRedis(redis);
    const ready = checks.postgres && checks.redis;
    return reply.status(ready ? 200 : 503).send({ status: ready ? "ready" : "degraded", checks });
  });

  app.get("/metrics", async (_request, reply) => {
    reply.type(registry.contentType);
    return registry.metrics();
  });

  // ── /api/v1 modules ────────────────────────────────────────────────────────
  const authenticate = makeAuthenticate(config.JWT_SECRET);
  const superAdmins = parseSuperAdmins(config.SUPERADMIN_EMAILS);
  const superAdminGuard = makeSuperAdminGuard(superAdmins);
  await app.register(
    async (api) => {
api.get("/meta/version", async () => {
        const license = activeLicense();
        return {
          name: "tokenledger",
          version: process.env.npm_package_version ?? "0.1.0",
          edition: license ? "enterprise" : "community",
          ...(license
            ? {
                plan: license.plan,
                entitlements: EE_FEATURES.filter((f) => entitled(f)),
              }
            : {}),
        };
      });
      registerAuthModule(api, {
        prisma,
        jwtSecret: config.JWT_SECRET,
        authenticate,
        secureCookies: config.NODE_ENV === "production",
        superAdmins,
      });
      registerAdminModule(api, { prisma, authenticate, superAdminGuard });
      registerOrgModule(api, { prisma, authenticate });
      registerTeamsModule(api, { prisma, authenticate });
      registerCredentialsModule(api, { prisma, authenticate, ring });
      registerKeysModule(api, { prisma, redis, authenticate });
      registerAnalyticsModule(api, { prisma, authenticate });
      registerExportsModule(api, { prisma, authenticate, exportQueue });
      registerInvitationsModule(api, {
        prisma,
        authenticate,
        mailer: createMailer(config.SMTP_URL, logger, "TokenLedger <noreply@tokenledger.local>"),
        publicBaseUrl: config.PUBLIC_BASE_URL,
      });
registerBudgetsModule(api, { prisma, redis, authenticate });
      registerPricingModule(api, { prisma, authenticate });
    },
    { prefix: "/api/v1" },
  );

  return { app, prisma, redis };
}
