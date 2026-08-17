import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { ConflictError, ForbiddenError, NotFoundError } from "@tokentrail/shared";
import { Prisma, type Provider } from "@tokentrail/db";
import { makeWorkspaceGuard } from "../plugins/guards.js";

const PROVIDERS = ["ANTHROPIC", "OPENAI", "GEMINI", "MINIMAX", "OPENROUTER", "DEEPSEEK", "OLLAMA"] as const;

// Money fields: Decimal(12,6) — accept strings to preserve precision. The gateway
// hot path uses the same string-only contract (see packages/pricing/src/calculator.ts).
const priceFields = {
  inputPerMtok: z.string().regex(/^\d+(\.\d{1,6})?$/),
  outputPerMtok: z.string().regex(/^\d+(\.\d{1,6})?$/),
  cacheReadPerMtok: z.string().regex(/^\d+(\.\d{1,6})?$/).default("0"),
  cacheWritePerMtok: z.string().regex(/^\d+(\.\d{1,6})?$/).default("0"),
} as const;

const listQuerySchema = z.object({
  provider: z.enum(PROVIDERS).optional(),
  // ISO-8601 timestamp; null = the currently-effective row per (provider, pattern).
  at: z.string().datetime().optional(),
});

const overrideSchema = z.object({
  provider: z.enum(PROVIDERS),
  // Glob pattern as stored on the row: exact id or trailing-*. (matches matcher.ts)
  modelPattern: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:/\-*]+$/),
  ...priceFields,
});

interface PricingModuleOptions {
  prisma: import("@tokentrail/db").PrismaClient;
  authenticate: preHandlerHookHandler;
}

export function registerPricingModule(app: FastifyInstance, opts: PricingModuleOptions): void {
  const { prisma, authenticate } = opts;
  const admin = [authenticate, makeWorkspaceGuard(prisma, "ADMIN")];
  const member = [authenticate, makeWorkspaceGuard(prisma, "VIEWER")];

  // GET /api/v1/pricing/models
  // Global catalog (member-only). Optional ?provider=&at= filters.
  app.get("/pricing/models", { preHandler: [authenticate] }, async (request) => {
    const q = listQuerySchema.parse(request.query ?? {});
    const at = q.at ? new Date(q.at) : new Date();
    const rows = await prisma.modelPrice.findMany({
      where: {
        ...(q.provider ? { provider: q.provider as Provider } : {}),
        effectiveFrom: { lte: at },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
      },
      orderBy: [{ provider: "asc" }, { modelPattern: "asc" }],
    });
    return {
      data: rows.map((r) => ({
        id: r.id,
        provider: r.provider,
        modelPattern: r.modelPattern,
        inputPerMtok: r.inputPerMtok.toString(),
        outputPerMtok: r.outputPerMtok.toString(),
        cacheReadPerMtok: r.cacheReadPerMtok.toString(),
        cacheWritePerMtok: r.cacheWritePerMtok.toString(),
        effectiveFrom: r.effectiveFrom,
        effectiveTo: r.effectiveTo,
        source: r.source,
      })),
    };
  });

  // GET /api/v1/workspaces/:ws/pricing/overrides
  app.get("/workspaces/:ws/pricing/overrides", { preHandler: member }, async (request) => {
    const rows = await prisma.modelPriceOverride.findMany({
      where: { workspaceId: request.wsCtx!.workspaceId },
      orderBy: [{ provider: "asc" }, { modelPattern: "asc" }],
    });
    return { data: rows.map(serializeOverride) };
  });

  // POST /api/v1/workspaces/:ws/pricing/overrides
  // ADMIN-only. Used by workspace owners to negotiate enterprise rates or pin
  // a specific model to $0 (e.g. internal Ollama). The gateway hot path picks
  // overrides over the catalog (matcher.ts precedence).
  app.post("/workspaces/:ws/pricing/overrides", { preHandler: admin }, async (request, reply) => {
    const workspaceId = request.wsCtx!.workspaceId;
    const body = overrideSchema.parse(request.body);

    const existing = await prisma.modelPriceOverride.findUnique({
      where: { workspaceId_provider_modelPattern: { workspaceId, provider: body.provider as Provider, modelPattern: body.modelPattern } },
    });
    if (existing) throw new ConflictError(
      `Override already exists for ${body.provider}/${body.modelPattern} — use PATCH to update it`,
    );

    const created = await prisma.modelPriceOverride.create({
      data: {
        workspaceId,
        provider: body.provider as Provider,
        modelPattern: body.modelPattern,
        inputPerMtok: new Prisma.Decimal(body.inputPerMtok),
        outputPerMtok: new Prisma.Decimal(body.outputPerMtok),
        cacheReadPerMtok: new Prisma.Decimal(body.cacheReadPerMtok),
        cacheWritePerMtok: new Prisma.Decimal(body.cacheWritePerMtok),
      },
    });
    return reply.status(201).send(serializeOverride(created));
  });

  // PATCH /api/v1/workspaces/:ws/pricing/overrides/:id
  // Partial update of any money field, or modelPattern rename. Re-keying the
  // (provider, modelPattern) unique is allowed but rejected if it would collide.
  app.patch("/workspaces/:ws/pricing/overrides/:id", { preHandler: admin }, async (request) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.wsCtx!.workspaceId;
    const body = overrideSchema.partial().parse(request.body);

    const existing = await prisma.modelPriceOverride.findFirst({
      where: { id, workspaceId },
    });
    if (!existing) throw new NotFoundError("Pricing override", id);

    // Only OWNERs can re-key (provider, modelPattern); admins can only edit money.
    const isRekeying =
      (body.provider !== undefined && body.provider !== existing.provider) ||
      (body.modelPattern !== undefined && body.modelPattern !== existing.modelPattern);
    if (isRekeying && request.wsCtx!.role !== "OWNER") {
      throw new ForbiddenError("Only workspace OWNERs can change the (provider, model) of an override");
    }

    if (isRekeying) {
      const conflict = await prisma.modelPriceOverride.findFirst({
        where: {
          workspaceId,
          provider: (body.provider as Provider) ?? existing.provider,
          modelPattern: body.modelPattern ?? existing.modelPattern,
          NOT: { id },
        },
      });
      if (conflict) throw new ConflictError(
        `Another override already targets ${body.provider}/${body.modelPattern}`,
      );
    }

    const data: Prisma.ModelPriceOverrideUpdateInput = {};
    if (body.provider !== undefined) data.provider = body.provider as Provider;
    if (body.modelPattern !== undefined) data.modelPattern = body.modelPattern;
    if (body.inputPerMtok !== undefined) data.inputPerMtok = new Prisma.Decimal(body.inputPerMtok);
    if (body.outputPerMtok !== undefined) data.outputPerMtok = new Prisma.Decimal(body.outputPerMtok);
    if (body.cacheReadPerMtok !== undefined) data.cacheReadPerMtok = new Prisma.Decimal(body.cacheReadPerMtok);
    if (body.cacheWritePerMtok !== undefined) data.cacheWritePerMtok = new Prisma.Decimal(body.cacheWritePerMtok);

    const updated = await prisma.modelPriceOverride.update({ where: { id }, data });
    return serializeOverride(updated);
  });

  // DELETE /api/v1/workspaces/:ws/pricing/overrides/:id
  app.delete("/workspaces/:ws/pricing/overrides/:id", { preHandler: admin }, async (request) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.wsCtx!.workspaceId;
    const deleted = await prisma.modelPriceOverride.deleteMany({ where: { id, workspaceId } });
    if (deleted.count === 0) throw new NotFoundError("Pricing override", id);
    return { ok: true };
  });

  // GET /api/v1/workspaces/:ws/pricing/unpriced
  // Distinct (provider, model) pairs seen in usage_event traffic in the last 30 days
  // for which no catalog or override price could be matched. Useful for admins to
  // spot gaps after they add a new provider credential or a vendor ships a new model.
  app.get("/workspaces/:ws/pricing/unpriced", { preHandler: admin }, async (request) => {
    const workspaceId = request.wsCtx!.workspaceId;
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const rows = await prisma.$queryRaw<
      { provider: Provider; model: string; requests: bigint; cost_lost: Prisma.Decimal }[]
    >`
      SELECT "provider"::text AS provider,
             model,
             COUNT(*)::bigint AS requests,
             COALESCE(SUM("costUsd"), 0)::numeric AS cost_lost
        FROM "usage_event"
       WHERE "workspaceId" = ${workspaceId}::uuid
         AND "occurredAt" >= ${since}
         AND "costBasis" = 'UNPRICED'
       GROUP BY "provider", model
       ORDER BY requests DESC
       LIMIT 200
    `;

    return {
      data: rows.map((r) => ({
        provider: r.provider,
        model: r.model,
        requests: Number(r.requests),
        costLostUsd: r.cost_lost.toString(),
      })),
    };
  });
}

function serializeOverride(r: {
  id: string;
  workspaceId: string;
  provider: string;
  modelPattern: string;
  inputPerMtok: Prisma.Decimal | string;
  outputPerMtok: Prisma.Decimal | string;
  cacheReadPerMtok: Prisma.Decimal | string;
  cacheWritePerMtok: Prisma.Decimal | string;
  createdAt: Date;
}) {
  const dec = (v: Prisma.Decimal | string) => (typeof v === "string" ? v : v.toString());
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    provider: r.provider,
    modelPattern: r.modelPattern,
    inputPerMtok: dec(r.inputPerMtok),
    outputPerMtok: dec(r.outputPerMtok),
    cacheReadPerMtok: dec(r.cacheReadPerMtok),
    cacheWritePerMtok: dec(r.cacheWritePerMtok),
    createdAt: r.createdAt,
  };
}
