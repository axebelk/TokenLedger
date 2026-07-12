import type { PrismaClient } from "@tokentrail/db";
import type { Logger } from "@tokentrail/telemetry";

interface DayAgg {
  d: string; // 'YYYY-MM-DD' in UTC
  requests: number;
  cost: string;
}

/**
 * Safety net: rollups are maintained transactionally alongside raw inserts, so
 * they should always match. This job re-derives daily totals from raw events
 * for the recent window and logs any drift (per day) — a nonzero drift means a
 * bug in the ingest transaction and should page someone. Read-only.
 *
 * Both sides key on the UTC calendar date as a string: the worker buckets
 * rollups at UTC midnight, and `date_trunc`/`to_char` default to the session
 * timezone, so we pin both to UTC to avoid a false-positive off-by-one.
 */
export async function runReconcile(
  prisma: PrismaClient,
  logger: Logger,
  windowDays = 7,
): Promise<{ checkedDays: number; driftDays: number }> {
  const from = new Date(Date.now() - windowDays * 86_400_000);
  from.setUTCHours(0, 0, 0, 0);

  const rawRows = await prisma.$queryRaw<DayAgg[]>`
    SELECT to_char("occurredAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d,
           COUNT(*)::int AS requests,
           COALESCE(SUM("costUsd"), 0)::text AS cost
    FROM usage_event
    WHERE "occurredAt" >= ${from} AND kind = 'REQUEST'
    GROUP BY d`;

  const rollupRows = await prisma.$queryRaw<DayAgg[]>`
    SELECT to_char(bucket AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d,
           COALESCE(SUM(requests), 0)::int AS requests,
           COALESCE(SUM("costUsd"), 0)::text AS cost
    FROM usage_rollup_daily
    WHERE bucket >= ${from}
    GROUP BY d`;

  const rollupByDay = new Map(rollupRows.map((r) => [r.d, r]));
  let driftDays = 0;

  for (const raw of rawRows) {
    const roll = rollupByDay.get(raw.d);
    const reqDrift = (roll?.requests ?? 0) - raw.requests;
    const costDrift = Math.abs(Number(roll?.cost ?? 0) - Number(raw.cost));
    if (reqDrift !== 0 || costDrift > 1e-6) {
      driftDays += 1;
      logger.warn(
        { day: raw.d, rawRequests: raw.requests, rollupRequests: roll?.requests ?? 0, rawCost: raw.cost, rollupCost: roll?.cost ?? "0" },
        "rollup drift detected — ingest transaction may have a bug",
      );
    }
  }

  logger.info({ checkedDays: rawRows.length, driftDays }, "reconcile complete");
  return { checkedDays: rawRows.length, driftDays };
}
