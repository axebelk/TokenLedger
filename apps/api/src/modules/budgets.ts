import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import {
  BUDGET_PERIODS, BUDGET_SCOPES, ENFORCEMENTS,
  ConflictError, LicenseRequiredError, NotFoundError, ValidationError,
} from "@tokenledger/shared";
import { Prisma, type PrismaClient } from "@tokenledger/db";
import { type Redis } from "@tokenledger/queue";
import { entitled } from "@tokenledger/ee-licensing";
import { budgetBlockKey } from "@tokenledger/ee-gateway";
import { periodWindow } from "@tokenledger/ee-worker";
import { makeWorkspaceGuard } from "../plugins/guards.js";

const budgetSchema = z.object({
  scopeType: z.enum(BUDGET_SCOPES),
  scopeId: z.string().uuid(),
  period: z.enum(BUDGET_PERIODS).default("MONTHLY"),
  amountUsd: z.number().positive().max(100_000_000),
  alertThresholds: z.array(z.number().int().min(1).max(500)).max(10).default([50, 80, 100]),
  enforcement: z.enum(ENFORCEMENTS).default("ALERT"),
  softGracePct: z.number().int().min(0).max(100).default(10),
});

interface BudgetsModuleOptions {
  prisma: PrismaClient;
  redis: Redis;
  authenticate: preHandlerHookHandler;
}

export function registerBudgetsModule(app: FastifyInstance, opts: BudgetsModuleOptions): void {
  const { prisma, redis, authenticate } = opts;
  const admin = [authenticate, makeWorkspaceGuard(prisma, "ADMIN")];
  const member = [authenticate, makeWorkspaceGuard(prisma, "VIEWER")];

  function requireEnforcementEntitlement(enforcement: string): void {
    // Alerting is community; blocking traffic is the enterprise feature.
    if (enforcement !== "ALERT" && !entitled("budget_enforcement")) {
      throw new LicenseRequiredError("budget_enforcement");
    }
  }

  async function assertScopeInWorkspace(workspaceId: string, scopeType: string, scopeId: string) {
    const exists =
      scopeType === "WORKSPACE"
        ? scopeId === workspaceId
        : scopeType === "PROJECT"
          ? (await prisma.project.findFirst({ where: { id: scopeId, workspaceId } })) !== null
          : scopeType === "TEAM"
            ? (await prisma.team.findFirst({ where: { id: scopeId, workspaceId } })) !== null
            : (await prisma.workspaceMember.findFirst({ where: { userId: scopeId, workspaceId } })) !== null;
    if (!exists) throw new ValidationError(`${scopeType} scope '${scopeId}' is not in this workspace`);
  }

  app.get("/workspaces/:ws/budgets", { preHandler: member }, async (request) => {
    const budgets = await prisma.budget.findMany({
      where: { workspaceId: request.wsCtx!.workspaceId, status: "ACTIVE" },
      orderBy: { createdAt: "asc" },
    });
    return { data: budgets.map(serialize) };
  });

  app.post("/workspaces/:ws/budgets", { preHandler: admin }, async (request, reply) => {
    const body = budgetSchema.parse(request.body);
    const workspaceId = request.wsCtx!.workspaceId;
    requireEnforcementEntitlement(body.enforcement);
    await assertScopeInWorkspace(workspaceId, body.scopeType, body.scopeId);

    try {
      const budget = await prisma.budget.create({
        data: { workspaceId, ...body, amountUsd: new Prisma.Decimal(body.amountUsd) },
      });
      return reply.status(201).send(serialize(budget));
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") {
        throw new ConflictError("A budget for this scope and period already exists");
      }
      throw err;
    }
  });

  app.patch("/workspaces/:ws/budgets/:id", { preHandler: admin }, async (request) => {
    const { id } = request.params as { id: string };
    const body = budgetSchema
      .pick({ amountUsd: true, alertThresholds: true, enforcement: true, softGracePct: true })
      .partial()
      .parse(request.body);
    if (body.enforcement) requireEnforcementEntitlement(body.enforcement);

    const existing = await prisma.budget.findFirst({
      where: { id, workspaceId: request.wsCtx!.workspaceId },
    });
    if (!existing) throw new NotFoundError("Budget", id);

    const data: Prisma.BudgetUpdateInput = {};
    if (body.amountUsd !== undefined) data.amountUsd = new Prisma.Decimal(body.amountUsd);
    if (body.alertThresholds !== undefined) data.alertThresholds = body.alertThresholds;
    if (body.enforcement !== undefined) data.enforcement = body.enforcement;
    if (body.softGracePct !== undefined) data.softGracePct = body.softGracePct;
    const budget = await prisma.budget.update({ where: { id }, data });
    // Raising a budget or dropping to ALERT should unblock quickly, not in ≤60 s.
    await redis.del(budgetBlockKey(budget.scopeType, budget.scopeId)).catch(() => {});
    return serialize(budget);
  });

  app.delete("/workspaces/:ws/budgets/:id", { preHandler: admin }, async (request) => {
    const { id } = request.params as { id: string };
    const budget = await prisma.budget.findFirst({
      where: { id, workspaceId: request.wsCtx!.workspaceId },
    });
    if (!budget) throw new NotFoundError("Budget", id);
    await prisma.budget.delete({ where: { id } });
    await redis.del(budgetBlockKey(budget.scopeType, budget.scopeId)).catch(() => {});
    return { ok: true };
  });

  app.get("/workspaces/:ws/budgets/status", { preHandler: member }, async (request) => {
    const budgets = await prisma.budget.findMany({
      where: { workspaceId: request.wsCtx!.workspaceId, status: "ACTIVE" },
    });
    const statuses = await Promise.all(
      budgets.map(async (budget) => {
        const window = periodWindow(budget.period);
        const { _sum } = await prisma.usageRollupHourly.aggregate({
          where: {
            workspaceId: budget.workspaceId,
            bucket: { gte: window.start, lt: window.end },
            ...(budget.scopeType === "PROJECT" ? { projectId: budget.scopeId } : {}),
            ...(budget.scopeType === "USER" ? { userId: budget.scopeId } : {}),
            ...(budget.scopeType === "TEAM" ? { teamId: budget.scopeId } : {}),
          },
          _sum: { costUsd: true },
        });
        const spent = _sum.costUsd ?? new Prisma.Decimal(0);
        const blocked =
          (await redis.exists(budgetBlockKey(budget.scopeType, budget.scopeId)).catch(() => 0)) === 1;
        return {
          budgetId: budget.id,
          scopeType: budget.scopeType,
          scopeId: budget.scopeId,
          period: budget.period,
          enforcement: budget.enforcement,
          amountUsd: budget.amountUsd.toString(),
          spentUsd: spent.toString(),
          pct: budget.amountUsd.isZero() ? 100 : spent.div(budget.amountUsd).mul(100).toNumber(),
          blocked,
          periodStart: window.start.toISOString(),
          periodEnd: window.end.toISOString(),
        };
      }),
    );
    return { data: statuses };
  });
}

function serialize(budget: {
  id: string; scopeType: string; scopeId: string; period: string;
  amountUsd: Prisma.Decimal; alertThresholds: number[]; enforcement: string;
  softGracePct: number; createdAt: Date;
}) {
  return { ...budget, amountUsd: budget.amountUsd.toString() };
}
