import Fastify, { type FastifyError } from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { DomainError } from "@tokentrail/shared";
import { keyRingFromEnv } from "@tokentrail/auth";
import { createLogger, createMetricsRegistry } from "@tokentrail/telemetry";
import { createPrismaClient } from "@tokentrail/db";
import { createQueue, createRedis, pingRedis, QUEUES } from "@tokentrail/queue";
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
import { createMailer } from "./lib/mailer.js";

export type ApiServer = Awaited<ReturnType<typeof buildServer>>;

export async function buildServer(config: ApiConfig) {
  const logger = createLogger("api", config.LOG_LEVEL);
  const registry = createMetricsRegistry("api");
  const prisma = createPrismaClient(config.DATABASE_URL);
  const redis = createRedis(config.REDIS_URL);
  const exportQueue = createQueue(QUEUES.exportCsv, redis);
  const ring = config.TOKENTRAIL_MASTER_KEY ? keyRingFromEnv(config.TOKENTRAIL_MASTER_KEY) : null;

  const app = Fastify({
    loggerInstance: logger,
    genReqId: () => randomUUID(),
    disableRequestLogging: config.NODE_ENV === "production",
  });

  await app.register(helmet);
  await app.register(cors, { origin: config.PUBLIC_BASE_URL, credentials: true });
  await app.register(cookie);

  // RFC 9457 problem+json for everything that escapes a handler.
  app.setErrorHandler((error: FastifyError | ZodError | DomainError, request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).type("application/problem+json").send({
        type: "https://tokentrail.dev/problems/validation_failed",
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
          type: `https://tokentrail.dev/problems/${error.code}`,
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
      api.get("/meta/version", async () => ({
        name: "tokentrail",
        version: process.env.npm_package_version ?? "0.1.0",
        edition: "community",
      }));
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
        mailer: createMailer(config.SMTP_URL, logger, "TokenTrail <noreply@tokentrail.local>"),
        publicBaseUrl: config.PUBLIC_BASE_URL,
      });
    },
    { prefix: "/api/v1" },
  );

  return { app, prisma, redis };
}
