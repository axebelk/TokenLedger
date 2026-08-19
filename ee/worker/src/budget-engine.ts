import { Prisma, type PrismaClient } from "@tokenledger/db";
import type { Redis } from "@tokenledger/queue";
import type { Logger } from "@tokenledger/telemetry";
import { budgetBlockKey } from "@tokenledger/ee-gateway";
import { periodWindow } from "./period.js";

interface BudgetEngineOptions {
  prisma: PrismaClient;
  redis: Redis;
  logger: Logger;
  intervalMs?: number;
}

export interface BudgetEngineHandle {
  stop(): void;
  /** Exposed for tests and manual runs. */
  tick(): Promise<void>;
}

/**
 * Budget engine (SRS FR-BUD-3/4): every minute, recompute spend for each
 * active budget from hourly rollups and maintain the Redis block flags the
 * gateway checks. Eventually consistent by design — worst-case overshoot is
 * one interval of burn. Threshold crossings are recorded as deduplicated
 * BudgetNotification rows (email/Slack fan-out reads these).
 */
export function startBudgetEngine(opts: BudgetEngineOptions): BudgetEngineHandle {
  const { prisma, redis, logger, intervalMs = 60_000 } = opts;

  async function tick(): Promise<void> {
    const budgets = await prisma.budget.findMany({ where: { status: "ACTIVE" } });
    for (const budget of budgets) {
      try {
        await evaluate(budget);
      } catch (err) {
        logger.error({ err, budgetId: budget.id }, "budget evaluation failed");
      }
    }
  }

  async function evaluate(budget: {
    id: string;
    workspaceId: string;
    scopeType: string;
    scopeId: string;
    period: "DAILY" | "WEEKLY" | "MONTHLY" | "QUARTERLY";
    amountUsd: Prisma.Decimal;
    alertThresholds: number[];
    enforcement: "ALERT" | "SOFT" | "HARD";
    softGracePct: number;
  }): Promise<void> {
    const window = periodWindow(budget.period);
    const where: Prisma.UsageRollupHourlyWhereInput = {
      workspaceId: budget.workspaceId,
      bucket: { gte: window.start, lt: window.end },
      ...scopeFilter(budget.scopeType, budget.scopeId),
    };
    const { _sum } = await prisma.usageRollupHourly.aggregate({ where, _sum: { costUsd: true } });
    const spent = _sum.costUsd ?? new Prisma.Decimal(0);

    // Threshold notifications (deduped by the unique constraint).
    const pct = budget.amountUsd.isZero() ? 100 : spent.div(budget.amountUsd).mul(100).toNumber();
    for (const threshold of budget.alertThresholds) {
      if (pct >= threshold) {
        await prisma.budgetNotification
          .create({
            data: {
              budgetId: budget.id,
              periodStart: window.start,
              threshold,
              channel: "email",
            },
          })
          .then(() => {
            // TODO(notify): enqueue the actual email/Slack send here.
            logger.info({ budgetId: budget.id, threshold, pct: pct.toFixed(1) }, "budget threshold crossed");
          })
          .catch((err: unknown) => {
            if (!isUniqueViolation(err)) throw err;
          });
      }
    }

    // Enforcement flags for the gateway.
    const blockKey = budgetBlockKey(budget.scopeType, budget.scopeId);
    const limit =
      budget.enforcement === "SOFT"
        ? budget.amountUsd.mul(1 + budget.softGracePct / 100)
        : budget.amountUsd;
    const shouldBlock = budget.enforcement !== "ALERT" && spent.gte(limit);

    if (shouldBlock) {
      const ttlS = Math.max(60, Math.ceil((window.end.getTime() - Date.now()) / 1000));
      await redis.set(
        blockKey,
        JSON.stringify({ budgetId: budget.id, resetsAt: window.end.toISOString() }),
        "EX",
        ttlS,
      );
    } else {
      await redis.del(blockKey);
    }
  }

  const timer = setInterval(() => {
    void tick().catch((err) => logger.error({ err }, "budget engine tick failed"));
  }, intervalMs);
  timer.unref();
  void tick().catch((err) => logger.error({ err }, "budget engine first tick failed"));

  return { stop: () => clearInterval(timer), tick };
}

function scopeFilter(scopeType: string, scopeId: string): Prisma.UsageRollupHourlyWhereInput {
  switch (scopeType) {
    case "PROJECT":
      return { projectId: scopeId };
    case "USER":
      return { userId: scopeId };
    case "TEAM":
      return { teamId: scopeId };
    default:
      return {}; // WORKSPACE — already filtered by workspaceId
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "P2002";
}
