import { Prisma, type PrismaClient } from "@tokentrail/db";
import type { UsageEventMessage } from "@tokentrail/queue";
import { groupRollups } from "./rollups.js";

/**
 * Persists a batch atomically:
 *   1. INSERT … ON CONFLICT DO NOTHING RETURNING id   (at-least-once → exactly-once)
 *   2. rollup upserts computed from ONLY the rows that actually inserted,
 *      so stream redeliveries can never double-count (ADR-4).
 */
export async function persistBatch(prisma: PrismaClient, events: UsageEventMessage[]): Promise<number> {
  if (events.length === 0) return 0;

  return prisma.$transaction(async (tx) => {
    const inserted = await insertEvents(tx, events);
    if (inserted.size === 0) return 0;

    const fresh = events.filter((e) => inserted.has(e.id));
    await touchVirtualKeys(tx, fresh);
    for (const g of groupRollups(fresh)) {
      for (const table of ["usage_rollup_hourly", "usage_rollup_daily"] as const) {
        const bucket = table === "usage_rollup_hourly" ? g.bucketHour : g.bucketDay;
        await tx.$executeRaw`
          INSERT INTO ${Prisma.raw(table)}
            (bucket, "workspaceId", "projectId", "teamId", "userId", provider, model,
             requests, errors, "inputTokens", "outputTokens", "cacheReadTokens",
             "cacheWriteTokens", "reasoningTokens", "costUsd", "latencyMsSum", "latencyCount")
          VALUES
            (${bucket}, ${g.workspaceId}::uuid, ${g.projectId}::uuid, ${g.teamId}::uuid,
             ${g.userId}::uuid, ${g.provider}::"Provider", ${g.model},
             ${g.requests}, ${g.errors}, ${g.inputTokens}, ${g.outputTokens},
             ${g.cacheReadTokens}, ${g.cacheWriteTokens}, ${g.reasoningTokens},
             ${g.costUsd}::numeric, ${g.latencyMsSum}, ${g.latencyCount})
          ON CONFLICT (bucket, "workspaceId", "projectId", "userId", provider, model)
          DO UPDATE SET
            requests = ${Prisma.raw(table)}.requests + EXCLUDED.requests,
            errors = ${Prisma.raw(table)}.errors + EXCLUDED.errors,
            "inputTokens" = ${Prisma.raw(table)}."inputTokens" + EXCLUDED."inputTokens",
            "outputTokens" = ${Prisma.raw(table)}."outputTokens" + EXCLUDED."outputTokens",
            "cacheReadTokens" = ${Prisma.raw(table)}."cacheReadTokens" + EXCLUDED."cacheReadTokens",
            "cacheWriteTokens" = ${Prisma.raw(table)}."cacheWriteTokens" + EXCLUDED."cacheWriteTokens",
            "reasoningTokens" = ${Prisma.raw(table)}."reasoningTokens" + EXCLUDED."reasoningTokens",
            "costUsd" = ${Prisma.raw(table)}."costUsd" + EXCLUDED."costUsd",
            "latencyMsSum" = ${Prisma.raw(table)}."latencyMsSum" + EXCLUDED."latencyMsSum",
            "latencyCount" = ${Prisma.raw(table)}."latencyCount" + EXCLUDED."latencyCount"`;
      }
    }
    return inserted.size;
  });
}

type Tx = Prisma.TransactionClient;

/** Keeps virtual_key.lastUsedAt fresh — off the gateway hot path by design. */
async function touchVirtualKeys(tx: Tx, events: UsageEventMessage[]): Promise<void> {
  const latest = new Map<string, string>();
  for (const e of events) {
    const seen = latest.get(e.virtualKeyId);
    if (!seen || e.occurredAt > seen) latest.set(e.virtualKeyId, e.occurredAt);
  }
  if (latest.size === 0) return;

  const values = Prisma.join(
    [...latest.entries()].map(([id, ts]) => Prisma.sql`(${id}::uuid, ${new Date(ts)}::timestamptz)`),
  );
  await tx.$executeRaw`
    UPDATE virtual_key vk SET "lastUsedAt" = v.ts
    FROM (VALUES ${values}) AS v(id, ts)
    WHERE vk.id = v.id AND (vk."lastUsedAt" IS NULL OR vk."lastUsedAt" < v.ts)`;
}

async function insertEvents(tx: Tx, events: UsageEventMessage[]): Promise<Set<string>> {
  const values = Prisma.join(
    events.map(
      (e) => Prisma.sql`(
        ${e.id}::uuid, ${new Date(e.occurredAt)}, ${e.workspaceId}::uuid, ${e.projectId}::uuid,
        ${e.teamId ?? null}::uuid, ${e.userId}::uuid, ${e.virtualKeyId}::uuid,
        ${e.credentialId ?? null}::uuid, ${e.poolId ?? null}::uuid,
        ${e.provider}::"Provider", ${e.modelRaw}, ${e.model}, ${e.endpoint}, ${e.requestId},
        'REQUEST'::"EventKind", ${e.status}::"EventStatus", ${e.httpStatus}, ${e.streamed},
        ${e.inputTokens}, ${e.outputTokens}, ${e.cacheReadTokens}, ${e.cacheWriteTokens},
        ${e.reasoningTokens}, ${e.costUsd}::numeric,
        ${e.unitPrices ? JSON.stringify(e.unitPrices) : null}::jsonb,
        ${e.costBasis}::"CostBasis", ${e.latencyMs}, ${e.ttftMs ?? null},
        ${e.tags ?? []}::text[]
      )`,
    ),
  );

  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO usage_event
      (id, "occurredAt", "workspaceId", "projectId", "teamId", "userId", "virtualKeyId",
       "credentialId", "poolId", provider, "modelRaw", model, endpoint, "requestId",
       kind, status, "httpStatus", streamed,
       "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens",
       "reasoningTokens", "costUsd", "unitPrices", "costBasis", "latencyMs", "ttftMs", tags)
    VALUES ${values}
    ON CONFLICT (id, "occurredAt") DO NOTHING
    RETURNING id`;

  return new Set(rows.map((r) => r.id));
}
