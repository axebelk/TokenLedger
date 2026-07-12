import { Prisma, type PrismaClient } from "@tokentrail/db";

/**
 * Analytics explorer queries over the rollup tables (docs/07 §8). All dynamic
 * SQL identifiers come from these whitelists — never from user input — so the
 * only interpolated-by-value parts are Prisma-parameterized bind values.
 */

export const DIMENSIONS = ["project", "team", "user", "provider", "model"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const METRICS = ["cost", "requests", "tokens", "errors"] as const;
export type Metric = (typeof METRICS)[number];

export const GRANULARITIES = ["hour", "day", "week", "month"] as const;
export type Granularity = (typeof GRANULARITIES)[number];

const DIM_COLUMN: Record<Dimension, string> = {
  project: '"projectId"',
  team: '"teamId"',
  user: '"userId"',
  provider: "provider",
  model: "model",
};

const METRIC_EXPR: Record<Metric, string> = {
  cost: 'COALESCE(SUM("costUsd"), 0)',
  requests: "COALESCE(SUM(requests), 0)",
  tokens: 'COALESCE(SUM("inputTokens" + "outputTokens"), 0)',
  errors: "COALESCE(SUM(errors), 0)",
};

export interface ExplorerFilters {
  projectId?: string;
  teamId?: string;
  userId?: string;
  provider?: string;
  model?: string;
}

/** Builds the shared WHERE clause: workspace + range + filters + RBAC scope. */
function buildWhere(
  workspaceId: string,
  from: Date,
  to: Date,
  filters: ExplorerFilters,
  scopeUserId: string | undefined,
): Prisma.Sql {
  const preds: Prisma.Sql[] = [
    Prisma.sql`"workspaceId" = ${workspaceId}::uuid`,
    Prisma.sql`bucket >= ${from}`,
    Prisma.sql`bucket < ${to}`,
  ];
  if (filters.projectId) preds.push(Prisma.sql`"projectId" = ${filters.projectId}::uuid`);
  if (filters.teamId) preds.push(Prisma.sql`"teamId" = ${filters.teamId}::uuid`);
  if (filters.userId) preds.push(Prisma.sql`"userId" = ${filters.userId}::uuid`);
  if (filters.provider) preds.push(Prisma.sql`provider = ${filters.provider}::"Provider"`);
  if (filters.model) preds.push(Prisma.sql`model = ${filters.model}`);
  // RBAC trim: a scoped member only ever sees their own usage.
  if (scopeUserId) preds.push(Prisma.sql`"userId" = ${scopeUserId}::uuid`);
  return Prisma.join(preds, " AND ");
}

function tableFor(granularity: Granularity): Prisma.Sql {
  return Prisma.raw(granularity === "hour" ? "usage_rollup_hourly" : "usage_rollup_daily");
}
function truncUnit(granularity: Granularity): string {
  return granularity; // whitelisted by the zod enum on the route
}

export interface TimeseriesPoint {
  t: string;
  v: number;
}
export interface TimeseriesSeries {
  key: Record<string, string>;
  points: TimeseriesPoint[];
}

export async function queryTimeseries(
  prisma: PrismaClient,
  params: {
    workspaceId: string;
    from: Date;
    to: Date;
    metric: Metric;
    granularity: Granularity;
    groupBy?: Dimension;
    filters: ExplorerFilters;
    scopeUserId?: string;
  },
): Promise<TimeseriesSeries[]> {
  const where = buildWhere(params.workspaceId, params.from, params.to, params.filters, params.scopeUserId);
  const metricExpr = Prisma.raw(METRIC_EXPR[params.metric]);
  const trunc = Prisma.raw(`date_trunc('${truncUnit(params.granularity)}', bucket)`);

  if (params.groupBy) {
    const dim = Prisma.raw(DIM_COLUMN[params.groupBy]);
    const rows = await prisma.$queryRaw<{ t: Date; k: string | null; v: number | string }[]>`
      SELECT ${trunc} AS t, ${dim} AS k, ${metricExpr} AS v
      FROM ${tableFor(params.granularity)}
      WHERE ${where}
      GROUP BY t, k
      ORDER BY t ASC`;

    const labels = await resolveLabels(prisma, params.groupBy, rows.map((r) => r.k));
    const byKey = new Map<string, TimeseriesSeries>();
    for (const row of rows) {
      const id = row.k ?? "unknown";
      let series = byKey.get(id);
      if (!series) {
        series = { key: { id, name: labels.get(id) ?? id }, points: [] };
        byKey.set(id, series);
      }
      series.points.push({ t: row.t.toISOString(), v: Number(row.v) });
    }
    return [...byKey.values()];
  }

  const rows = await prisma.$queryRaw<{ t: Date; v: number | string }[]>`
    SELECT ${trunc} AS t, ${metricExpr} AS v
    FROM ${tableFor(params.granularity)}
    WHERE ${where}
    GROUP BY t
    ORDER BY t ASC`;
  return [{ key: {}, points: rows.map((r) => ({ t: r.t.toISOString(), v: Number(r.v) })) }];
}

export interface BreakdownRow {
  key: { id: string; name: string };
  costUsd: string;
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  errorRate: number;
  sharePct: number;
}

export async function queryBreakdown(
  prisma: PrismaClient,
  params: {
    workspaceId: string;
    from: Date;
    to: Date;
    groupBy: Dimension;
    filters: ExplorerFilters;
    scopeUserId?: string;
    limit: number;
  },
): Promise<{ rows: BreakdownRow[]; totalCostUsd: string }> {
  const where = buildWhere(params.workspaceId, params.from, params.to, params.filters, params.scopeUserId);
  const dim = Prisma.raw(DIM_COLUMN[params.groupBy]);

  const raw = await prisma.$queryRaw<
    { k: string | null; cost: string; requests: bigint; errors: bigint; intok: bigint; outtok: bigint }[]
  >`
    SELECT ${dim} AS k,
           COALESCE(SUM("costUsd"), 0) AS cost,
           COALESCE(SUM(requests), 0) AS requests,
           COALESCE(SUM(errors), 0) AS errors,
           COALESCE(SUM("inputTokens"), 0) AS intok,
           COALESCE(SUM("outputTokens"), 0) AS outtok
    FROM ${tableFor("day")}
    WHERE ${where}
    GROUP BY k
    ORDER BY cost DESC
    LIMIT ${params.limit}`;

  const labels = await resolveLabels(prisma, params.groupBy, raw.map((r) => r.k));
  const total = raw.reduce((sum, r) => sum + Number(r.cost), 0);
  const rows: BreakdownRow[] = raw.map((r) => {
    const requests = Number(r.requests);
    const cost = Number(r.cost);
    const id = r.k ?? "unknown";
    return {
      key: { id, name: labels.get(id) ?? id },
      costUsd: r.cost,
      requests,
      errors: Number(r.errors),
      inputTokens: Number(r.intok),
      outputTokens: Number(r.outtok),
      errorRate: requests > 0 ? Number(r.errors) / requests : 0,
      sharePct: total > 0 ? (cost / total) * 100 : 0,
    };
  });
  return { rows, totalCostUsd: total.toFixed(8) };
}

/** Resolve id → display name for project/team/user; provider/model are their own names. */
async function resolveLabels(
  prisma: PrismaClient,
  dimension: Dimension,
  keys: (string | null)[],
): Promise<Map<string, string>> {
  const ids = [...new Set(keys.filter((k): k is string => k != null))];
  const labels = new Map<string, string>();
  if (dimension === "provider" || dimension === "model" || ids.length === 0) return labels;

  if (dimension === "project") {
    const rows = await prisma.project.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    for (const r of rows) labels.set(r.id, r.name);
  } else if (dimension === "team") {
    const rows = await prisma.team.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    for (const r of rows) labels.set(r.id, r.name);
  } else if (dimension === "user") {
    const rows = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    for (const r of rows) labels.set(r.id, r.name);
  }
  return labels;
}
