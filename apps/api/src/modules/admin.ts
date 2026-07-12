import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import type { PrismaClient } from "@tokentrail/db";

/**
 * Instance super-admin API (cross-workspace). Guarded by SUPERADMIN_EMAILS —
 * these routes deliberately bypass workspace scoping to give a platform
 * operator a fleet-wide view. Read-only for now.
 */
interface AdminModuleOptions {
  prisma: PrismaClient;
  authenticate: preHandlerHookHandler;
  superAdminGuard: preHandlerHookHandler;
}

export function registerAdminModule(app: FastifyInstance, opts: AdminModuleOptions): void {
  const { prisma, authenticate, superAdminGuard } = opts;
  const guard = [authenticate, superAdminGuard];
  const from = () => new Date(Date.now() - 30 * 86_400_000);

  app.get("/admin/stats", { preHandler: guard }, async () => {
    const [workspaces, users, activeKeys, agg] = await Promise.all([
      prisma.workspace.count({ where: { deletedAt: null } }),
      prisma.user.count({ where: { status: "ACTIVE" } }),
      prisma.virtualKey.count({ where: { status: "ACTIVE" } }),
      prisma.usageRollupDaily.aggregate({
        where: { bucket: { gte: from() } },
        _sum: { requests: true, costUsd: true },
      }),
    ]);
    return {
      workspaces,
      users,
      activeKeys,
      requests30d: agg._sum.requests ?? 0,
      costUsd30d: (agg._sum.costUsd ?? 0).toString(),
    };
  });

  // Platform-wide daily spend/requests for the last 30 days — powers the
  // Reports trend chart. Buckets are already UTC-pinned timestamptz.
  app.get("/admin/timeseries", { preHandler: guard }, async () => {
    const rows = await prisma.usageRollupDaily.groupBy({
      by: ["bucket"],
      where: { bucket: { gte: from() } },
      _sum: { requests: true, costUsd: true },
      orderBy: { bucket: "asc" },
    });
    return {
      data: rows.map((r) => ({
        date: r.bucket.toISOString().slice(0, 10),
        requests: Number(r._sum.requests ?? 0),
        costUsd: (r._sum.costUsd ?? 0).toString(),
      })),
    };
  });

  app.get("/admin/workspaces", { preHandler: guard }, async () => {
    const [workspaces, rollups] = await Promise.all([
      prisma.workspace.findMany({
        where: { deletedAt: null },
        orderBy: { createdAt: "asc" },
        include: { _count: { select: { members: true, projects: true } } },
      }),
      prisma.usageRollupDaily.groupBy({
        by: ["workspaceId"],
        where: { bucket: { gte: from() } },
        _sum: { requests: true, costUsd: true },
      }),
    ]);
    const usage = new Map(rollups.map((r) => [r.workspaceId, r._sum]));
    return {
      data: workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        slug: w.slug,
        createdAt: w.createdAt,
        members: w._count.members,
        projects: w._count.projects,
        requests30d: Number(usage.get(w.id)?.requests ?? 0),
        costUsd30d: (usage.get(w.id)?.costUsd ?? 0).toString(),
      })),
    };
  });
}
