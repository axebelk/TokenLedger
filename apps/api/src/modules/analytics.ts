import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { hasMinimumRole } from "@tokentrail/shared";
import type { PrismaClient, Prisma } from "@tokentrail/db";
import { makeWorkspaceGuard } from "../plugins/guards.js";

const summaryQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

const eventsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

interface AnalyticsModuleOptions {
  prisma: PrismaClient;
  authenticate: preHandlerHookHandler;
}

/**
 * Phase 1 analytics: headline summary + provider/model breakdowns from daily
 * rollups, and the raw event explorer. The full timeseries/breakdown explorer
 * API (docs/07 §8) lands in Phase 2.
 */
export function registerAnalyticsModule(app: FastifyInstance, opts: AnalyticsModuleOptions): void {
  const { prisma, authenticate } = opts;
  const member = [authenticate, makeWorkspaceGuard(prisma, "VIEWER")];

  /** MEMBERs see their own usage; ADMIN/OWNER/VIEWER see workspace-wide. */
  function scopeFilter(request: { wsCtx?: { role: string }; user?: { id: string } }) {
    const role = request.wsCtx!.role;
    const wide = hasMinimumRole(role as never, "ADMIN") || role === "VIEWER";
    return wide ? {} : { userId: request.user!.id };
  }

  app.get("/workspaces/:ws/analytics/summary", { preHandler: member }, async (request) => {
    const { days } = summaryQuery.parse(request.query ?? {});
    const from = new Date(Date.now() - days * 86_400_000);
    const where: Prisma.UsageRollupDailyWhereInput = {
      workspaceId: request.wsCtx!.workspaceId,
      bucket: { gte: from },
      ...scopeFilter(request),
    };

    const [totals, byProvider, byModel, byDay] = await Promise.all([
      prisma.usageRollupDaily.aggregate({
        where,
        _sum: {
          costUsd: true, requests: true, errors: true,
          inputTokens: true, outputTokens: true,
        },
      }),
      prisma.usageRollupDaily.groupBy({
        by: ["provider"],
        where,
        _sum: { costUsd: true, requests: true },
        orderBy: { _sum: { costUsd: "desc" } },
      }),
      prisma.usageRollupDaily.groupBy({
        by: ["provider", "model"],
        where,
        _sum: { costUsd: true, requests: true },
        orderBy: { _sum: { costUsd: "desc" } },
        take: 8,
      }),
      prisma.usageRollupDaily.groupBy({
        by: ["bucket"],
        where,
        _sum: { costUsd: true, requests: true },
        orderBy: { bucket: "asc" },
      }),
    ]);

    const requests = totals._sum.requests ?? 0;
    const errors = totals._sum.errors ?? 0;
    return {
      rangeDays: days,
      costUsd: (totals._sum.costUsd ?? 0).toString(),
      requests,
      inputTokens: Number(totals._sum.inputTokens ?? 0n),
      outputTokens: Number(totals._sum.outputTokens ?? 0n),
      errorRate: requests > 0 ? errors / requests : 0,
      byProvider: byProvider.map((r) => ({
        provider: r.provider,
        costUsd: (r._sum.costUsd ?? 0).toString(),
        requests: r._sum.requests ?? 0,
      })),
      byModel: byModel.map((r) => ({
        provider: r.provider,
        model: r.model,
        costUsd: (r._sum.costUsd ?? 0).toString(),
        requests: r._sum.requests ?? 0,
      })),
      byDay: byDay.map((r) => ({
        date: r.bucket.toISOString().slice(0, 10),
        costUsd: (r._sum.costUsd ?? 0).toString(),
        requests: r._sum.requests ?? 0,
      })),
    };
  });

  app.get("/workspaces/:ws/usage/events", { preHandler: member }, async (request) => {
    const { limit, cursor } = eventsQuery.parse(request.query ?? {});
    const where: Prisma.UsageEventWhereInput = {
      workspaceId: request.wsCtx!.workspaceId,
      ...scopeFilter(request),
      ...(cursor ? { occurredAt: { lt: decodeCursor(cursor) } } : {}),
    };

    const events = await prisma.usageEvent.findMany({
      where,
      orderBy: [{ occurredAt: "desc" }],
      take: limit + 1,
      select: {
        id: true, occurredAt: true, provider: true, model: true, endpoint: true,
        status: true, httpStatus: true, streamed: true,
        inputTokens: true, outputTokens: true, cacheReadTokens: true,
        costUsd: true, costBasis: true, latencyMs: true, ttftMs: true, requestId: true,
        project: { select: { id: true, name: true, slug: true } },
        user: { select: { id: true, name: true } },
      },
    });

    const page = events.slice(0, limit);
    const last = page[page.length - 1];
    return {
      data: page.map((e) => ({ ...e, costUsd: e.costUsd.toString() })),
      nextCursor: events.length > limit && last ? encodeCursor(last.occurredAt) : null,
    };
  });
}

function encodeCursor(occurredAt: Date): string {
  return Buffer.from(occurredAt.toISOString()).toString("base64url");
}

function decodeCursor(cursor: string): Date {
  const date = new Date(Buffer.from(cursor, "base64url").toString("utf8"));
  if (Number.isNaN(date.getTime())) return new Date();
  return date;
}
